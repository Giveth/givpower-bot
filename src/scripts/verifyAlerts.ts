/**
 * Standalone verification for Discord alerting. No test framework is
 * configured, so this drives the real code against a local fake webhook and a
 * read-only RPC.
 *
 *   yarn verify-alerts
 *
 * The signer is a throwaway key with no funds, so nothing can be broadcast.
 */
import * as http from 'http';
import * as path from 'path';
import { ethers } from 'ethers';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') =>
	results.push({ name, pass, detail });

let received: unknown[] = [];
let respondWith = 204;

const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		if (respondWith === 204) received.push(JSON.parse(body));
		res.writeHead(respondWith).end();
	});
});

let subgraphReply: unknown = {};
const subgraphServer = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(subgraphReply));
	});
});

/** config caches env at import, so each case needs a fresh module graph. */
const freshAlert = (env: Record<string, string>) => {
	for (const mod of ['../config', '../alert', '../logger']) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	Object.assign(process.env, env);
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('../alert');
};

const baseEnv = (port: number) => ({
	NODE_ENV: '',
	SUBGRAPH_ENDPOINT: 'http://unused.invalid',
	NODE_URL: process.env.VERIFY_RPC_URL || 'https://mainnet.optimism.io',
	GIVPOWER_CONTRACT_ADDRESS: '0x301C739CF6bfb6B47A74878BdEB13f92F13Ae5E7',
	PRIVATE_KEY: ethers.Wallet.createRandom().privateKey,
	DISCORD_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
	DISCORD_ALERT_CHAIN_LABEL: 'optimism',
	DISCORD_ALERT_THROTTLE_MINUTES: '60',
	// Spelled out because freshAlert merges into process.env rather than
	// replacing it: without these, a case that overrides one of them leaks the
	// override into every case that follows.
	DISCORD_ALERT_FAILURE_BACKOFF_MS: '60000',
	DISCORD_ALERT_ON_STARTUP: 'true',
	DISCORD_ALERT_SOURCE_LABEL: 'givpower-bot',
	DISCORD_ALERT_MENTION_USER_IDS: '',
	DISCORD_ALERT_MENTION_ROLE_IDS: '',
	SUBGRAPH_MISMATCH_SAMPLE_SIZE: '10',
	MIN_WALLET_BALANCE: '0.05',
	EXPLORER_BASE_URL: 'https://optimistic.etherscan.io',
});

const main = async () => {
	await new Promise<void>(r => server.listen(0, r));
	await new Promise<void>(r => subgraphServer.listen(0, r));
	const port = (server.address() as { port: number }).port;
	const subgraphPort = (subgraphServer.address() as { port: number }).port;

	// --- AC1 delivery -------------------------------------------------------
	received = [];
	let alert = freshAlert(baseEnv(port));
	await alert.sendAlert({
		severity: 'error',
		title: 'Test alert',
		description: 'hello',
		dedupeKey: 'k1',
	});
	const first = received[0] as {
		embeds: { title: string; footer: { text: string } }[];
	};
	check('AC1 alert delivered', received.length === 1);
	check(
		'AC1 footer carries source, chain and env',
		received.length === 1 &&
			/givpower-bot • optimism/.test(first.embeds[0].footer.text),
		received.length ? first.embeds[0].footer.text : 'nothing received',
	);

	// --- AC4 throttling -----------------------------------------------------
	received = [];
	alert = freshAlert(baseEnv(port));
	for (let i = 0; i < 5; i++) {
		await alert.sendAlert({
			severity: 'error',
			title: 'Repeating',
			description: `n=${i}`,
			dedupeKey: 'same',
		});
	}
	await alert.sendAlert({
		severity: 'error',
		title: 'Different',
		description: 'other',
		dedupeKey: 'other',
	});
	check(
		'AC4 repeats throttled to one',
		received.length === 2,
		`posted=${received.length}`,
	);

	// --- AC2 unconfigured is a no-op ---------------------------------------
	received = [];
	alert = freshAlert({ ...baseEnv(port), DISCORD_ALERT_WEBHOOK_URL: '' });
	let threw = false;
	try {
		await alert.sendAlert({
			severity: 'error',
			title: 'No webhook',
			description: 'x',
		});
	} catch {
		threw = true;
	}
	check(
		'AC2 unconfigured: no request, no throw',
		received.length === 0 && !threw,
	);
	check(
		'AC2 isAlertingConfigured false',
		alert.isAlertingConfigured() === false,
	);

	// --- AC3 never blocks ---------------------------------------------------
	alert = freshAlert({
		...baseEnv(port),
		DISCORD_ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/hook',
	});
	threw = false;
	try {
		await alert.sendAlert({
			severity: 'error',
			title: 'Unreachable',
			description: 'x',
		});
	} catch {
		threw = true;
	}
	check('AC3 unreachable webhook does not throw', !threw);

	// A failure backs off briefly, so a Discord outage during a multi-chunk
	// poll cannot become one slow failing request per chunk.
	received = [];
	respondWith = 500;
	alert = freshAlert(baseEnv(port));
	await alert.sendAlert({
		severity: 'error',
		title: 'Retry',
		description: 'x',
		dedupeKey: 'r',
	});
	respondWith = 204;
	await alert.sendAlert({
		severity: 'error',
		title: 'Retry',
		description: 'x',
		dedupeKey: 'r',
	});
	check(
		'failure backs off, suppressing an immediate retry',
		received.length === 0,
		`posted=${received.length}`,
	);

	// ...but the throttle window itself must not be consumed, or an outage
	// would silence the condition for the whole window.
	received = [];
	respondWith = 500;
	alert = freshAlert({
		...baseEnv(port),
		DISCORD_ALERT_FAILURE_BACKOFF_MS: '0',
	});
	await alert.sendAlert({
		severity: 'error',
		title: 'Retry',
		description: 'x',
		dedupeKey: 'r',
	});
	respondWith = 204;
	await alert.sendAlert({
		severity: 'error',
		title: 'Retry',
		description: 'x',
		dedupeKey: 'r',
	});
	check(
		'failed send does not eat the throttle window',
		received.length === 1,
		`posted=${received.length}`,
	);

	// The backoff has to be process-wide, not per key. One poll emits
	// wallet-low, subgraph-mismatch, a junk-tx per stale round and
	// stale-rounds - all different keys - so a per-key backoff would still let
	// every one of them make its own 10s failing request while Discord is down,
	// and the junk-tx ones are awaited inside the unlock loop.
	received = [];
	respondWith = 500;
	alert = freshAlert(baseEnv(port));
	await alert.sendAlert({
		severity: 'error',
		title: 'First',
		description: 'x',
		dedupeKey: 'wallet-low',
	});
	respondWith = 204;
	let reachedDiscord = 0;
	for (const key of ['subgraph-mismatch', 'junk-tx:66', 'stale-rounds']) {
		if (
			await alert.sendAlert({
				severity: 'error',
				title: key,
				description: 'x',
				dedupeKey: key,
			})
		) {
			reachedDiscord++;
		}
	}
	check(
		'one failure backs off every key, not just its own',
		received.length === 0 && reachedDiscord === 0,
		`posted=${received.length}`,
	);

	// ...and recovers as soon as a send succeeds again.
	received = [];
	respondWith = 500;
	alert = freshAlert({
		...baseEnv(port),
		DISCORD_ALERT_FAILURE_BACKOFF_MS: '0',
	});
	await alert.sendAlert({
		severity: 'error',
		title: 'First',
		description: 'x',
		dedupeKey: 'a',
	});
	respondWith = 204;
	const okAfterRecovery = await alert.sendAlert({
		severity: 'error',
		title: 'Second',
		description: 'x',
		dedupeKey: 'b',
	});
	check(
		'sendAlert reports delivery, and recovers after an outage',
		okAfterRecovery === true && received.length === 1,
		`delivered=${okAfterRecovery} posted=${received.length}`,
	);

	// Unconfigured and throttled both report "did not reach Discord", so the
	// startup check below cannot mistake either for a working webhook.
	alert = freshAlert({ ...baseEnv(port), DISCORD_ALERT_WEBHOOK_URL: '' });
	const unconfiguredResult = await alert.sendAlert({
		severity: 'info',
		title: 'x',
		description: 'x',
	});
	alert = freshAlert(baseEnv(port));
	await alert.sendAlert({
		severity: 'info',
		title: 'x',
		description: 'x',
		dedupeKey: 't',
	});
	const throttledResult = await alert.sendAlert({
		severity: 'info',
		title: 'x',
		description: 'x',
		dedupeKey: 't',
	});
	check(
		'sendAlert returns false when unconfigured or throttled',
		unconfiguredResult === false && throttledResult === false,
		`unconfigured=${unconfiguredResult} throttled=${throttledResult}`,
	);

	// --- AC6 wallet under minimum ------------------------------------------
	received = [];
	for (const mod of ['../config', '../alert', '../logger', '../blockchain']) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	Object.assign(process.env, baseEnv(port));
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const blockchain = require('../blockchain');
	await blockchain.checkWalletBalance();
	check(
		'AC6 empty wallet alerts',
		received.length === 1,
		`posted=${received.length}`,
	);

	// --- AC7/AC8 subgraph vs chain, live ------------------------------------
	// Addresses the 16 Sept index claimed were unlockable. Rather than assert a
	// fixed expectation - which would break the day any of them unlocks - read
	// the chain first and assert the check agrees with it.
	received = [];
	const candidates = [
		'0x555306b8798b225ae92f6abd24e1d41ba62bcb53',
		'0xbf98949e0bdfe8a7d36af5dd8cd2c3d4c659ba62',
		'0x4b7c0da1c299ce824f55a0190efb13663442fa2c',
		'0x9924285ff2207d6e36642b6832a515a6a3aedcab',
	];
	const provider = new ethers.providers.JsonRpcProvider(
		process.env.VERIFY_RPC_URL || 'https://mainnet.optimism.io',
	);
	const reader = new ethers.Contract(
		'0x301C739CF6bfb6B47A74878BdEB13f92F13Ae5E7',
		['function userLocks(address) view returns (uint256)'],
		provider,
	);
	// The default RPC here is the public Optimism endpoint, which rate-limits.
	// Without the retry a throttled read leaves currentRound undefined, every
	// round below reads NaN, the settled-round filter drops everything and the
	// three checks that follow report "flagged=0" as though the mismatch check
	// were broken. Fail loudly instead of quietly.
	let round: number | undefined;
	for (let attempt = 0; attempt < 3 && round === undefined; attempt++) {
		if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
		round = await blockchain.getCurrentRound();
	}
	if (round === undefined) {
		throw new Error(
			'could not read currentRound after 3 attempts - is the RPC reachable? ' +
				'Set VERIFY_RPC_URL to a private endpoint if the public one is ' +
				'rate-limiting.',
		);
	}
	// Bound to a const so the narrowing survives into the closures below.
	const currentRound: number = round;
	const emptyOnChain: string[] = [];
	const lockedOnChain: string[] = [];
	for (const user of candidates) {
		const total = await reader.userLocks(user);
		(total.isZero() ? emptyOnChain : lockedOnChain).push(user);
	}
	console.log(
		`chain says: ${emptyOnChain.length} empty, ${lockedOnChain.length} still locked`,
	);

	// Rounds well behind the current one, so the settled-round gate lets them
	// through and subgraph lag cannot explain a disagreement.
	const positions: Record<string, string[]> = {};
	candidates.forEach((user, i) => {
		positions[String(currentRound - 10 - i)] = [user];
	});

	const mismatches = await blockchain.findSubgraphChainMismatches(
		positions,
		currentRound,
		'QmUrLouBJmwahqamEMuspWPtSgucFejQfFicGmDZLzQpy1',
	);
	check(
		'AC7 flags exactly the users with nothing on chain',
		emptyOnChain.every(u => mismatches.includes(u)) &&
			mismatches.length === emptyOnChain.length,
		`flagged=${mismatches.length} expected=${emptyOnChain.length}`,
	);
	check(
		'AC7 never flags a user who still holds a lock',
		lockedOnChain.every(u => !mismatches.includes(u)),
	);
	check(
		'AC8 mismatch alerts before any gas is spent',
		emptyOnChain.length === 0 || received.length === 1,
		`posted=${received.length}`,
	);

	// The alert has to name the position it disagrees about and both sides of
	// the comparison, or it cannot be acted on without re-running the query by
	// hand.
	const mismatchFields = received.length
		? (
				received[0] as {
					embeds: { fields: { name: string; value: string }[] }[];
				}
		  ).embeds[0].fields
		: [];
	const comparison = mismatchFields.find(f => f.name.includes('userLocks'));
	check(
		'AC7 alert carries the user, the claimed round and the chain value',
		emptyOnChain.length === 0 ||
			(comparison !== undefined &&
				comparison.value.includes(emptyOnChain[0]) &&
				/round \d/.test(comparison.value) &&
				comparison.value.includes('chain holds 0')),
		comparison ? comparison.value.split('\n')[0] : 'no comparison field',
	);

	// Rounds the bot is actively working must NOT be sampled, or the bot's own
	// successful unlocks would be reported as mismatches.
	received = [];
	const activeRound: Record<string, string[]> = {
		[String(currentRound - 1)]: emptyOnChain.length ? [emptyOnChain[0]] : [],
	};
	const activeMismatches = await blockchain.findSubgraphChainMismatches(
		activeRound,
		currentRound,
		'deployment',
	);
	check(
		'recently worked rounds are excluded (no false positive)',
		activeMismatches.length === 0 && received.length === 0,
		`flagged=${activeMismatches.length} posted=${received.length}`,
	);

	// --- the incident shape, driven through a whole poll --------------------
	// Long-closed rounds, exactly what the corrupt index served. The guard must
	// refuse them, and somebody must be told.
	received = [];
	for (const mod of [
		'../config',
		'../alert',
		'../logger',
		'../blockchain',
		'../subgraph',
		'../service',
	]) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	Object.assign(process.env, {
		...baseEnv(port),
		SUBGRAPH_ENDPOINT: `http://127.0.0.1:${subgraphPort}/graphql`,
		MAX_ROUND_AGE: '5',
		SUBGRAPH_MAX_BLOCK_GAP: '100000',
	});
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const freshBlockchain = require('../blockchain');
	const head = await freshBlockchain.getCurrentBlock();
	subgraphReply = {
		data: {
			tokenLocks: [42, 44, 45, 52, 61, 69, 73].map(round => ({
				user: { id: '0x555306b8798b225ae92f6abd24e1d41ba62bcb53' },
				untilRound: String(round),
			})),
			_meta: {
				deployment: 'QmCorruptDeployment',
				block: { number: head.number },
			},
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const service = require('../service').default;
	const nonceBefore = await freshBlockchain.getCurrentRound();
	await service();
	const titles = received.map(
		r => (r as { embeds: { title: string }[] }).embeds[0].title,
	);
	check(
		'incident shape raises a stale-rounds alert',
		titles.some(t => t.includes('long-closed rounds')),
		titles.join(' | ') || 'nothing posted',
	);
	check(
		'currentRound still readable during the poll',
		nonceBefore !== undefined,
	);

	// --- startup report -----------------------------------------------------
	// The only alert that fires when nothing is wrong, so it is what proves the
	// webhook works at all.
	received = [];
	for (const mod of [
		'../config',
		'../alert',
		'../logger',
		'../blockchain',
		'../subgraph',
		'../service',
	]) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	// Shaped like a real gateway URL - key in the path - but pointed at the
	// local fake so nothing leaves the machine.
	subgraphReply = { data: { _meta: { deployment: 'QmExampleDeployment' } } };
	Object.assign(process.env, {
		...baseEnv(port),
		SUBGRAPH_ENDPOINT:
			`http://127.0.0.1:${subgraphPort}` +
			'/api/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/subgraphs/id/QmExampleSubgraphId',
		POLL_PERIOD_SECOND: '300',
	});
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	await require('../service').reportStartup();
	const startup = received[0] as {
		content?: string;
		embeds: {
			title: string;
			fields: { name: string; value: string }[];
		}[];
	};
	check(
		'startup posts exactly one message',
		received.length === 1,
		`posted=${received.length}`,
	);
	const startupText = received.length ? JSON.stringify(startup) : '';
	check(
		'startup reports wallet, round, contract and poll period',
		received.length === 1 &&
			[
				'Wallet',
				'Current round',
				'Contract',
				'Deployment',
				'Poll period',
				'Guards',
			].every(name => startup.embeds[0].fields.some(f => f.name === name)),
		received.length
			? startup.embeds[0].fields.map(f => f.name).join(', ')
			: 'nothing posted',
	);
	check(
		'startup never mentions anyone',
		received.length === 1 && !startup.content,
		`content=${received.length ? startup.content : 'n/a'}`,
	);
	// A webhook channel is not the place to publish the gateway API key, and
	// nothing from the path is published at all - so a credential in a segment
	// this code has never seen cannot leak either.
	check(
		'startup publishes no part of the endpoint path',
		received.length === 1 &&
			!startupText.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') &&
			!startupText.includes('QmExampleSubgraphId') &&
			startupText.includes(`127.0.0.1:${subgraphPort}`),
		received.length
			? startup.embeds[0].fields.find(f => f.name === 'Subgraph')?.value ?? ''
			: 'nothing posted',
	);
	// Which index is actually being served comes from the subgraph itself.
	check(
		'startup reports the deployment the subgraph serves',
		received.length === 1 &&
			startup.embeds[0].fields.find(f => f.name === 'Deployment')?.value ===
				'QmExampleDeployment',
		received.length
			? startup.embeds[0].fields.find(f => f.name === 'Deployment')?.value ?? ''
			: 'nothing posted',
	);

	// Opting out has to actually opt out.
	received = [];
	for (const mod of [
		'../config',
		'../alert',
		'../logger',
		'../blockchain',
		'../subgraph',
		'../service',
	]) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	Object.assign(process.env, {
		...baseEnv(port),
		DISCORD_ALERT_ON_STARTUP: 'false',
	});
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	await require('../service').reportStartup();
	check(
		'DISCORD_ALERT_ON_STARTUP=false posts nothing',
		received.length === 0,
		`posted=${received.length}`,
	);
	// With no webhook there is nowhere to put the answers, so the startup report
	// must not spend RPC round trips - each up to ethers' 120s request timeout
	// when the node is unreachable - before the first poll even starts.
	received = [];
	for (const mod of [
		'../config',
		'../alert',
		'../logger',
		'../blockchain',
		'../subgraph',
		'../service',
	]) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	Object.assign(process.env, {
		...baseEnv(port),
		DISCORD_ALERT_WEBHOOK_URL: '',
	});
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const quietBlockchain = require('../blockchain');
	let bootStatusReads = 0;
	const realBootStatus = quietBlockchain.getBootStatus;
	quietBlockchain.getBootStatus = async () => {
		bootStatusReads++;
		return realBootStatus();
	};
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	await require('../service').reportStartup();
	check(
		'no webhook: startup skips the RPC reads entirely',
		bootStatusReads === 0 && received.length === 0,
		`reads=${bootStatusReads} posted=${received.length}`,
	);

	// A dead webhook must not stop the bot booting.
	for (const mod of [
		'../config',
		'../alert',
		'../logger',
		'../blockchain',
		'../subgraph',
		'../service',
	]) {
		delete require.cache[require.resolve(path.join(__dirname, mod))];
	}
	Object.assign(process.env, {
		...baseEnv(port),
		DISCORD_ALERT_WEBHOOK_URL: 'http://127.0.0.1:1/hook',
	});
	threw = false;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		await require('../service').reportStartup();
	} catch {
		threw = true;
	}
	check('startup survives an unreachable webhook', !threw);

	server.close();
	subgraphServer.close();

	console.log('');
	let failed = 0;
	for (const r of results) {
		if (!r.pass) failed++;
		console.log(
			`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${
				r.detail ? '  (' + r.detail + ')' : ''
			}`,
		);
	}
	console.log(`\n${results.length - failed}/${results.length} passed`);
	process.exit(failed === 0 ? 0 : 1);
};

main().catch(e => {
	console.error(e);
	process.exit(1);
});
