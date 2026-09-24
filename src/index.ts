import config from './config';
import logger from './logger';
import service, { reportStartup } from './service';

async function main() {
	// Before the first poll, so a broken webhook shows up immediately rather
	// than the first time something is actually wrong. Guarded because main()'s
	// catch exits the process: a diagnostic must never be able to crash-loop
	// the bot it is there to watch.
	try {
		await reportStartup();
	} catch (e) {
		logger.error('Could not report startup', e);
	}

	// Poll in a loop rather than with setInterval: setInterval does not wait for
	// the previous run to finish, so a run slower than the poll period overlaps
	// the next one and both hand the same nonces to the signer.
	for (;;) {
		try {
			await service();
		} catch (e) {
			logger.error('Unhandled error during service run', e);
		}
		await new Promise(resolve =>
			setTimeout(resolve, config.pollPeriodSecond * 1000),
		);
	}
}

main().catch(e => {
	logger.error('Fatal error, exiting', e);
	process.exit(1);
});
