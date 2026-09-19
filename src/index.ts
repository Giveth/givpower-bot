import config from './config';
import logger from './logger';
import service from './service';

async function main() {
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
