import { gql, request } from 'graphql-request';
import config from './config';
import logger from './logger';
import { getCurrentBlock, getCurrentRound } from './blockchain';
import { ethers } from 'ethers';
import { UnlockablePositions } from '../types/shared';

/**
 * This desirable value is a little less than `POLL_PERIOD_SECOND / Network Average Block Time`
 * If POLL_PERIOD_SECOND 300 seconds (5m)
 * Mainnet < 300 / 20 = 15
 * Gnosis < 300 / 5 = 60
 */
const SUBGRAPH_NETWORK_MAX_BLOCK_GAP = 10;

let acceptableNetworkGap = SUBGRAPH_NETWORK_MAX_BLOCK_GAP;

const checkSubgraphHealth = (
	networkLatestBlock: ethers.providers.Block,
	subgraphNetworkNumber,
): boolean => {
	const { number: networkLatestBlockNumber } = networkLatestBlock;
	logger.info('network latest block:', networkLatestBlockNumber);
	logger.info('subgraph network number:', subgraphNetworkNumber);
	if (
		subgraphNetworkNumber + acceptableNetworkGap <=
		networkLatestBlockNumber
	) {
		logger.error(`Subgraph is ${
			networkLatestBlockNumber - subgraphNetworkNumber
		} behind network!
        Network Latest Block Number: ${networkLatestBlockNumber}
        Subgraph block number: ${subgraphNetworkNumber}
        `);

		// Next time use the data if subgraph block number will be good for this run!
		acceptableNetworkGap += SUBGRAPH_NETWORK_MAX_BLOCK_GAP;
		return false;
	}

	acceptableNetworkGap = Math.max(
		SUBGRAPH_NETWORK_MAX_BLOCK_GAP,
		acceptableNetworkGap - SUBGRAPH_NETWORK_MAX_BLOCK_GAP,
	);
	return true;
};

const getSubgraphData = async () => {
	let currentBlock;
	let subgraphResponse;
	try {
		currentBlock = (await getCurrentBlock()) as ethers.providers.Block;
	} catch (e) {
		logger.error('Error on getting latest block from network', e);
		return undefined;
	}

	if (!currentBlock) {
		logger.error('Current block is undefined!');
		return undefined;
	}

	const query = gql`
		query getUnlockablePositions($lastBlockTimeStamp: Int!) {
			tokenLocks(
				first: 100
				where: { unlocked: false, unlockableAt_lte: $lastBlockTimeStamp }
				orderBy: untilRound
				orderDirection: asc
			) {
				user {
					id
				}
				untilRound
			}
			_meta {
				block {
					number
				}
			}
		}
	`;

	try {
		console.log('subgraphEndpoint', config.subgraphEndpoint);
		subgraphResponse = await request(
			config.subgraphEndpoint,
			query,
			{
				lastBlockTimeStamp: currentBlock.timestamp,
			},
			{ origin: config.subgraphDomain },
		);
	} catch (e) {
		logger.error(
			'Error getting locked positions from subgraph',
			JSON.stringify(e, null, 2),
		);
		return undefined;
	}

	const subgraphBlockNumber = subgraphResponse?._meta?.block?.number;
	const isOk = checkSubgraphHealth(currentBlock, subgraphBlockNumber);
	return isOk && subgraphResponse;
};

export const getUnlockablePositions = async (): Promise<
	UnlockablePositions | undefined
> => {
	const subgraphResponse = await getSubgraphData();

	if (!subgraphResponse) return undefined;

	interface TokenLock {
		user: { id: string };
		untilRound: string;
	}

	const tokenLocks: TokenLock[] = subgraphResponse.tokenLocks;

	const result: UnlockablePositions = {};

	tokenLocks.forEach(tokenLock => {
		const {
			user: { id: userAddress },
			untilRound,
		} = tokenLock;
		if (result[untilRound]) {
			result[untilRound].push(userAddress);
		} else {
			result[untilRound] = [userAddress];
		}
	});

	for (const round of Object.keys(result)) {
		result[round] = Array.from(new Set(result[round])); // make unique
	}

	return result;
};
