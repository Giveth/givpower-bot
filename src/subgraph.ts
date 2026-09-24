import { gql, request, Variables } from 'graphql-request';
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

/** Which deployment the gateway last served us, for alert context. */
let lastDeployment = '';

export const getLastSubgraphDeployment = (): string => lastDeployment;

/**
 * Every subgraph query, bounded.
 *
 * graphql-request sets no timeout and the fetch beneath it has none either, so
 * an endpoint that accepts the connection and then never answers hangs the
 * caller forever. In the poll loop that stalls the bot while the container
 * still looks healthy - the same shape as the unbounded `tx.wait()` removed in
 * #11 - and at startup it would stop the first poll ever running.
 *
 * AbortController rather than AbortSignal.timeout so this does not depend on
 * the Node version, and the timer is always cleared so a fast reply cannot
 * leave one pending.
 */
const requestWithTimeout = async (
	query: string,
	variables: Variables = {},
): Promise<any> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.subgraphTimeoutMs);
	try {
		return await request({
			url: config.subgraphEndpoint,
			document: query,
			variables,
			requestHeaders: { origin: config.subgraphDomain },
			// graphql-request bundles its own DOM typings, whose AbortSignal is
			// not structurally identical to Node 18's global one. It is the
			// same object at runtime; the cast only reconciles the two
			// declarations.
			signal: controller.signal as any,
		});
	} finally {
		clearTimeout(timer);
	}
};

/**
 * The host the bot queries, with no path at all.
 *
 * The Graph's gateway carries its API key in the URL path. Recognising which
 * segment is the credential is a blocklist, and a blocklist fails open the
 * moment an endpoint uses a shape it does not know, so none of the path is
 * published. Which subgraph is actually being served is reported as a
 * deployment hash instead, which is public by construction.
 */
export const getSubgraphHost = (): string => {
	try {
		return new URL(config.subgraphEndpoint).host;
	} catch {
		return 'configured';
	}
};

/**
 * Asks the subgraph which deployment it is serving, for the startup report.
 * Doubles as proof that the endpoint is reachable and authenticated before
 * the first poll.
 *
 * Deliberately not `getUnlockablePositions()`: that runs the health check,
 * which widens `acceptableNetworkGap` when it fails. A diagnostic must not
 * loosen a guard before the first poll has even run.
 */
export const fetchSubgraphDeployment = async (): Promise<
	string | undefined
> => {
	const query = gql`
		query getDeployment {
			_meta {
				deployment
			}
		}
	`;
	try {
		const response = await requestWithTimeout(query);
		return response?._meta?.deployment || undefined;
	} catch (e) {
		logger.error('Could not read the subgraph deployment at startup', e);
		return undefined;
	}
};

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
				deployment
				block {
					number
				}
			}
		}
	`;

	try {
		logger.debug('subgraphEndpoint', config.subgraphEndpoint);
		subgraphResponse = await requestWithTimeout(query, {
			lastBlockTimeStamp: currentBlock.timestamp,
		});
	} catch (e) {
		logger.error(
			'Error getting locked positions from subgraph',
			JSON.stringify(e, null, 2),
		);
		return undefined;
	}

	lastDeployment = subgraphResponse?._meta?.deployment || '';
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
