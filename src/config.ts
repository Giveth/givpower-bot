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

const splitIds = (raw: string | undefined): string[] =>
	(raw || '')
		.split(',')
		.map(id => id.trim())
		.filter(Boolean);

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
	discordWebhookUrl: string;
	discordSourceLabel: string;
	chainLabel: string;
	alertThrottleMs: number;
	alertFailureBackoffMs: number;
	alertOnStartup: boolean;
	mentionUserIds: string[];
	mentionRoleIds: string[];
	explorerBaseUrl: string;
	minWalletBalance: number;
	mismatchSampleSize: number;
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
	 * rejected, in blocks.
	 *
	 * This is how far the subgraph trails the head when queried, not how many
	 * blocks pass between polls - measured at 0-1 blocks on both Optimism and
	 * Gnosis in normal operation. 10 is therefore already generous, and is
	 * what this was hardcoded to before, so deploying this change does not
	 * loosen any existing instance. Raise it only if a chain proves to need
	 * it.
	 */
	subgraphMaxBlockGap: numberFromEnv(process.env.SUBGRAPH_MAX_BLOCK_GAP, 10),

	/**
	 * How long to wait for an unlock transaction to be mined before giving up
	 * on it. The poll loop is serial, so an unmineable transaction would
	 * otherwise stop the bot polling indefinitely while it still looks healthy.
	 */
	txWaitTimeoutMs: Math.max(
		1_000,
		numberFromEnv(process.env.TX_WAIT_TIMEOUT_MS, 180_000),
	),

	/**
	 * Discord webhook for fault alerts. Unset disables alerting entirely, which
	 * is how every instance behaves until one is configured.
	 */
	discordWebhookUrl: process.env.DISCORD_ALERT_WEBHOOK_URL || '',

	/** Shown in the embed footer, so one shared channel stays readable. */
	discordSourceLabel: process.env.DISCORD_ALERT_SOURCE_LABEL || 'givpower-bot',

	/**
	 * Which chain this instance runs against. Set explicitly rather than read
	 * from the RPC so it is still correct when the RPC is down at boot.
	 */
	chainLabel: process.env.DISCORD_ALERT_CHAIN_LABEL || 'unknown-chain',

	/**
	 * How long the same condition stays quiet after alerting. At a 300s poll
	 * period a short window would post on nearly every poll.
	 */
	alertThrottleMs:
		numberFromEnv(process.env.DISCORD_ALERT_THROTTLE_MINUTES, 60) * 60 * 1000,

	/**
	 * How long to stay quiet after a failed send, so one Discord outage cannot
	 * turn a multi-chunk poll into a burst of slow failing requests.
	 */
	alertFailureBackoffMs: numberFromEnv(
		process.env.DISCORD_ALERT_FAILURE_BACKOFF_MS,
		60_000,
	),

	/**
	 * Post an informational message on every start. On by default: it is the
	 * only alert that fires when nothing is wrong, so without it a broken
	 * webhook looks exactly like a healthy bot.
	 */
	alertOnStartup: process.env.DISCORD_ALERT_ON_STARTUP !== 'false',

	mentionUserIds: splitIds(process.env.DISCORD_ALERT_MENTION_USER_IDS),
	mentionRoleIds: splitIds(process.env.DISCORD_ALERT_MENTION_ROLE_IDS),

	/** Used to link transactions in alerts, e.g. https://optimistic.etherscan.io */
	explorerBaseUrl: process.env.EXPLORER_BASE_URL || '',

	/** Native-currency balance below which the wallet is reported as low. */
	minWalletBalance: numberFromEnv(process.env.MIN_WALLET_BALANCE, 0.05),

	/**
	 * How many of the users the subgraph claims are unlockable to verify against
	 * the chain each poll. One disagreement is enough to prove the subgraph
	 * wrong, so a small sample is plenty.
	 */
	mismatchSampleSize: numberFromEnv(
		process.env.SUBGRAPH_MISMATCH_SAMPLE_SIZE,
		10,
	),
};

export default config;
