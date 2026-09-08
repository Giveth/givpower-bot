import logger from './logger';
import config from './config';
import { unlockPositions } from './blockchain';
import { getUnlockablePositions } from './subgraph';

let consecutiveIneffectivePolls = 0;
let halted = false;

const service = async () => {
	if (halted) {
		logger.error(
			'Bot is halted after repeatedly spending gas without unlocking ' +
				'anything. Fix the subgraph data, then restart the process.',
		);
		return;
	}

	const positions = await getUnlockablePositions();
	if (!positions) return;
	logger.info(positions);

	const summary = await unlockPositions(positions);

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
