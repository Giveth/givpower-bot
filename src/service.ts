import logger from './logger';
import config from './config';
import { isAlertingConfigured, sendAlert } from './alert';
import {
	checkWalletBalance,
	findSubgraphChainMismatches,
	getBootStatus,
	getCurrentRound,
	unlockPositions,
} from './blockchain';
import {
	fetchSubgraphDeployment,
	getLastSubgraphDeployment,
	getSubgraphHost,
	getUnlockablePositions,
} from './subgraph';

let consecutiveIneffectivePolls = 0;
let halted = false;

/**
 * Posts once per process start, before the first poll.
 *
 * Every other alert here fires only when something is wrong, so a broken
 * webhook is indistinguishable from a healthy bot - which is exactly how the
 * September incident stayed quiet. This is the one message that proves the
 * path works, and it carries the effective settings so a misconfigured
 * instance is visible without shelling into the container.
 *
 * Deliberately not suppressed across restarts: the throttle map is
 * in-process, so a container restart loop posts once per restart. That is
 * noisy by design - a bot that cannot stay up is worth hearing about.
 */
export const reportStartup = async (): Promise<void> => {
	if (!config.alertOnStartup) return;

	// Before the reads below, not after: with no webhook there is nowhere to
	// put the answers, and each read can sit on ethers' 120s request timeout
	// when the RPC is unreachable. The first poll makes the same calls anyway.
	if (!isAlertingConfigured()) {
		logger.warn(
			'Started with no DISCORD_ALERT_WEBHOOK_URL: faults will be logged ' +
				'here and nowhere else.',
		);
		return;
	}

	const { address, balance, currentRound } = await getBootStatus();
	const deployment = await fetchSubgraphDeployment();

	const delivered = await sendAlert({
		severity: 'info',
		title: 'GIVpower bot started',
		description:
			'The bot is up and alerting is working - this message is the proof. ' +
			'Everything below is the configuration it will actually run with.',
		fields: [
			{ name: 'Wallet', value: address },
			{
				name: 'Balance',
				value: balance ?? 'unreadable (RPC error)',
				inline: true,
			},
			{
				name: 'Current round',
				value:
					currentRound === undefined
						? 'unreadable (RPC error)'
						: String(currentRound),
				inline: true,
			},
			{
				name: 'Contract',
				value: config.givpowerContractAddress,
				inline: true,
			},
			{ name: 'Subgraph', value: getSubgraphHost() },
			{
				// The deployment hash, not the endpoint: it says which index is
				// actually being served, which is what distinguishes a
				// misconfigured instance from a correct one, and unlike the URL
				// it cannot carry a credential.
				name: 'Deployment',
				value: deployment ?? 'unreachable',
			},
			{
				name: 'Poll period',
				value: `${config.pollPeriodSecond}s`,
				inline: true,
			},
			{
				name: 'Guards',
				value:
					`max round age ${config.maxRoundAge}, halt after ` +
					`${config.maxIneffectivePolls} ineffective polls, subgraph lag ` +
					`${config.subgraphMaxBlockGap} blocks, tx wait ` +
					`${config.txWaitTimeoutMs}ms`,
			},
			{
				name: 'Alerting',
				value:
					`throttled to one message per ${Math.round(
						config.alertThrottleMs / 60000,
					)} min, ` +
					`${
						config.mentionUserIds.length + config.mentionRoleIds.length
					} mention target(s), low-balance threshold ` +
					`${config.minWalletBalance}`,
			},
		],
		// Startup is not a fault, so it must never wake anyone up.
		mention: false,
		dedupeKey: 'startup',
	});

	// A definitive line in the container logs either way, so alerting can be
	// verified from `docker logs` without reading the webhook URL back out.
	if (delivered) {
		logger.info('Startup alert delivered to Discord; alerting is working.');
	} else {
		logger.error(
			'Startup alert did NOT reach Discord. The webhook is set but not ' +
				'usable - check DISCORD_ALERT_WEBHOOK_URL.',
		);
	}
};

const service = async () => {
	if (halted) {
		// Alerted on every poll rather than once, so that a halted bot keeps
		// reminding someone instead of going quiet at the moment a human is
		// needed. The throttle reduces it to one message per window.
		await sendAlert({
			severity: 'critical',
			title: 'GIVpower bot is halted',
			description:
				'The bot stopped sending after repeatedly spending gas without ' +
				'unlocking anything, and will not resume until it is restarted. ' +
				'Check the subgraph before restarting it.',
			dedupeKey: 'halted',
		});
		return;
	}

	// Outside the positions path on purpose: an empty wallet must be reported
	// even when there is nothing to unlock.
	await checkWalletBalance();

	const positions = await getUnlockablePositions();
	if (!positions) return;
	logger.info(positions);

	const currentRound = await getCurrentRound();
	if (currentRound === undefined) {
		logger.error(
			'Skipping unlock run: could not read currentRound from the contract',
		);
		return;
	}

	// Alert only - refusing to act on bad data is the round-age guard's job.
	await findSubgraphChainMismatches(
		positions,
		currentRound,
		getLastSubgraphDeployment(),
	);

	const summary = await unlockPositions(positions, currentRound);

	// The exact fingerprint of both 2026 incidents: the subgraph offering up
	// rounds that closed long ago. The guard refuses them, which costs nothing,
	// but somebody still needs to know the index is wrong.
	if (summary.staleRoundsSkipped.length > 0) {
		await sendAlert({
			severity: 'error',
			title: 'Subgraph is offering long-closed rounds',
			description:
				`${summary.staleRoundsSkipped.length} round(s) that closed more than ` +
				`${config.maxRoundAge} rounds ago were reported as unlockable and ` +
				'have been refused. No gas was spent, but the subgraph index is wrong.',
			fields: [
				{ name: 'Current round', value: String(currentRound), inline: true },
				{
					name: 'Refused rounds',
					value: summary.staleRoundsSkipped.join(', '),
				},
				{
					name: 'Deployment',
					value: getLastSubgraphDeployment() || 'unknown',
				},
			],
			dedupeKey: 'stale-rounds',
		});
	}

	// Nothing was broadcast, so nothing was wasted. Leave the streak alone
	// rather than resetting it: a flaky RPC, or a subgraph that alternates
	// between all-stale and ineffective polls, would otherwise keep clearing
	// the counter and the breaker would never trip.
	if (summary.transactionsSent === 0) {
		return;
	}

	if (summary.positionsUnlocked > 0) {
		consecutiveIneffectivePolls = 0;
		return;
	}

	// A transaction we stopped waiting for may still confirm and do real work,
	// so a run containing one cannot be called ineffective. Leave the streak
	// where it is rather than advancing it on a maybe.
	if (summary.indeterminateTransactions > 0) {
		logger.warn(
			`Poll had ${summary.indeterminateTransactions} transaction(s) with no ` +
				'receipt yet; not counting this poll either way.',
		);
		return;
	}

	consecutiveIneffectivePolls += 1;
	logger.error(
		`Poll sent ${summary.transactionsSent} unlock transaction(s) and ` +
			`unlocked nothing ` +
			`(${consecutiveIneffectivePolls}/${config.maxIneffectivePolls}).`,
	);

	if (consecutiveIneffectivePolls >= config.maxIneffectivePolls) {
		halted = true;
		logger.error(
			`Halting after ${consecutiveIneffectivePolls} consecutive polls that ` +
				'spent gas without unlocking anything. The bot will send no further ' +
				'transactions until it is restarted.',
		);
	}
};

export default service;
