import * as dotenv from 'dotenv';
import path from 'path';
import logger from './logger';

dotenv.config({
	path: path.resolve(__dirname, `../config/${process.env.NODE_ENV || ''}.env`),
});

if (!process.env.GIVPOWER_CONTRACT_ADDRESS) {
	logger.error('GIVPOWER_CONTRACT_ADDRESS is not defined');
	process.exit(-1);
}

if (!process.env.SUBGRAPH_ENDPOINT) {
	logger.error('SUBGRAPH_ENDPOINT is not defined');
	process.exit(-1);
}

/**
 * `Number(x) || fallback` silently discards an explicit 0, which is a
 * meaningful setting for some of the guards below (MAX_ROUND_AGE=0 means
 * "only ever unlock the current round").
 */
const numberFromEnv = (
	raw: string | number | undefined,
	fallback: number,
): number => {
	if (raw === undefined || String(raw).trim() === '') return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const config: {
	nodeUrl: string;
	pollPeriodSecond: number;
	subgraphEndpoint: string;
	subgraphDomain: string;
	givpowerContractAddress: string;
	privateKey: string;
	unlockPerTransaction: number;
	gasMaxBaseFee: number;
	gasPriorityFee: number;
	noGasOverride: boolean;
	maxRoundAge: number;
	maxIneffectivePolls: number;
	subgraphMaxBlockGap: number;
	txWaitTimeoutMs: number;
} = {
	nodeUrl: process.env.NODE_URL || 'https://rpc.gnosischain.com/',
	pollPeriodSecond: Number(process.env.POLL_PERIOD_SECOND) || 60,
	subgraphEndpoint: process.env.SUBGRAPH_ENDPOINT,
	subgraphDomain: process.env.SUBGRAPH_DOMAIN || 'https://giveth.io',
	givpowerContractAddress: process.env.GIVPOWER_CONTRACT_ADDRESS,
	privateKey: process.env.PRIVATE_KEY || '',
	unlockPerTransaction: Number(process.env.UNLOCK_PER_TRANSACTION) || 1,
	gasMaxBaseFee: Number(process.env.GAS_MAX_BASE_FEE) || 2,
	gasPriorityFee: Number(process.env.GAS_PRIORITY_FEE) || 2,
	noGasOverride: process.env.NO_GAS_OVERRIDE === 'true',

	/**
	 * How many rounds behind the current round a position may be and still be
	 * worth an unlock transaction.
	 *
	 * `unlock()` silently does nothing when a position has already been
	 * unlocked, so a subgraph that wrongly reports an old lock as
	 * `unlocked: false` will make the bot resend the same transaction every
	 * poll, forever. Anything older than this is treated as bad subgraph data
	 * and reported instead of being sent. Raise it temporarily if there is a
	 * genuine unlock backlog.
	 */
	maxRoundAge: numberFromEnv(process.env.MAX_ROUND_AGE, 5),

	/**
	 * How many consecutive polls may spend gas without unlocking anything
	 * before the bot stops sending altogether and waits for a human.
	 */
	maxIneffectivePolls: numberFromEnv(process.env.MAX_INEFFECTIVE_POLLS, 3),

	/**
	 * How far behind the network head the subgraph may be before its data is
	 * rejected, in blocks. Should be a little under
	 * POLL_PERIOD_SECOND / network average block time, so it needs to be set
	 * per chain: at a 300s poll period that is ~15 on mainnet (20s blocks),
	 * ~60 on Gnosis (5s blocks) and ~150 on Optimism (2s blocks).
	 *
	 * The default deliberately matches the value this was hardcoded to before,
	 * so deploying this change does not loosen any existing instance. Set it
	 * per instance.
	 */
	subgraphMaxBlockGap: numberFromEnv(process.env.SUBGRAPH_MAX_BLOCK_GAP, 10),

	/**
	 * How long to wait for an unlock transaction to be mined before giving up
	 * on it. The poll loop is serial, so an unmineable transaction would
	 * otherwise stop the bot polling indefinitely while it still looks healthy.
	 */
	txWaitTimeoutMs: numberFromEnv(process.env.TX_WAIT_TIMEOUT_MS, 180_000),
};

export default config;
