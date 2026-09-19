import { gql, request } from 'graphql-request';
import config from './config';
import logger from './logger';
import { getCurrentBlock } from './blockchain';
import { ethers } from 'ethers';
import { UnlockablePositions } from '../types/shared';

/**
 * How far behind the network head the subgraph may be before we refuse its data.
 * See `subgraphMaxBlockGap` in config for how to size this per chain.
 */
const SUBGRAPH_NETWORK_MAX_BLOCK_GAP = config.subgraphMaxBlockGap;

/**
 * Hard ceiling for the widened tolerance below. Without it the tolerance grows
 * without bound on every failure, so a subgraph that is permanently behind
 * eventually passes the health check and the bot acts on stale data.
 */
const MAX_ACCEPTABLE_NETWORK_GAP = SUBGRAPH_NETWORK_MAX_BLOCK_GAP * 5;

let acceptableNetworkGap = SUBGRAPH_NETWORK_MAX_BLOCK_GAP;

const checkSubgraphHealth = (
	networkLatestBlock: ethers.providers.Block,
	subgraphNetworkNumber: number | undefined,
): boolean => {
	const { number: networkLatestBlockNumber } = networkLatestBlock;
	logger.info('network latest block:', networkLatestBlockNumber);
	logger.info('subgraph network number:', subgraphNetworkNumber);

	// Without this, a response missing _meta makes the comparison below NaN,
	// which is never true - so the subgraph would be declared healthy and the
	// tolerance would even be relaxed. An index corrupt enough to drop _meta is
	// exactly the one we must not act on.
	if (
		subgraphNetworkNumber === undefined ||
		!Number.isFinite(subgraphNetworkNumber)
	) {
		logger.error(
			'Subgraph did not report a block number (_meta missing or malformed); treating as unhealthy',
		);
		return false;
	}

	const subgraphBlockNumber: number = subgraphNetworkNumber;

	if (subgraphBlockNumber + acceptableNetworkGap < networkLatestBlockNumber) {
		logger.error(`Subgraph is ${
			networkLatestBlockNumber - subgraphBlockNumber
		} behind network!
        Network Latest Block Number: ${networkLatestBlockNumber}
        Subgraph block number: ${subgraphBlockNumber}
        Current tolerance: ${acceptableNetworkGap} blocks
        `);

		// Allow a little more lag next time, in case the subgraph is only
		// briefly behind, but never past the ceiling.
		acceptableNetworkGap = Math.min(
			MAX_ACCEPTABLE_NETWORK_GAP,
			acceptableNetworkGap + SUBGRAPH_NETWORK_MAX_BLOCK_GAP,
		);
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
		logger.debug('subgraphEndpoint', config.subgraphEndpoint);
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
