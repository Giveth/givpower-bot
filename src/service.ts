import logger from './logger';
import config from './config';
import { sendAlert } from './alert';
import {
	checkWalletBalance,
	findSubgraphChainMismatches,
	getCurrentRound,
	unlockPositions,
} from './blockchain';
import { getLastSubgraphDeployment, getUnlockablePositions } from './subgraph';

let consecutiveIneffectivePolls = 0;
let halted = false;

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
