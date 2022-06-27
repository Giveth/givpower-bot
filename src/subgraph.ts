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
	let currentRound;
	let currentBlock;
	let subgraphResponse;
	try {
		[currentRound, currentBlock] = await Promise.all([
			getCurrentRound(),
			getCurrentBlock(),
		]);
	} catch (e) {
		logger.error(
			'Error on getting last round and latest block from network',
			e,
		);
		return undefined;
	}

	const query = gql`
		query getUnlockablePositions($currentRound: Int!) {
			powerLocks(
				first: 100
				where: { unlocked: false, untilRound_lt: $currentRound }
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
		subgraphResponse = await request(config.subgraphEndpoint, query, {
			currentRound,
		});
	} catch (e) {
		logger.error('Error getting locked positions from subgraph', e);
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

	interface PowerLock {
		user: { id: string };
		untilRound: string;
	}

	const powerLocks: PowerLock[] = subgraphResponse.powerLocks;

	const result: UnlockablePositions = {};

	powerLocks.forEach(powerLock => {
		const {
			user: { id: userAddress },
			untilRound,
		} = powerLock;
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
