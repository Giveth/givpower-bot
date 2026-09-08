/**
 * Standalone verification for the guards in this repo. No test framework is
 * configured, so this runs the real code paths against a fake subgraph and a
 * real (read-only) RPC, and asserts the behaviour each guard promises.
 *
 *   yarn verify-guards
 *
 * The signer is a throwaway key with no funds, so nothing can be broadcast.
 */
import * as http from 'http';
import { ethers } from 'ethers';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') =>
	results.push({ name, pass, detail });

// Fake subgraph. `reply` is swapped per case.
let reply: unknown = {};
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(reply));
	});
});

const main = async () => {
	await new Promise<void>(r => server.listen(0, r));
	const port = (server.address() as { port: number }).port;

	// Object.assign rather than direct assignment: the ambient declarations in
	// types/environment.d.ts type these as numbers, though env values are always
	// strings at runtime.
	Object.assign(process.env, {
		NODE_ENV: '',
		SUBGRAPH_ENDPOINT: `http://127.0.0.1:${port}/graphql`,
		NODE_URL: process.env.VERIFY_RPC_URL || 'https://mainnet.optimism.io',
		GIVPOWER_CONTRACT_ADDRESS:
			process.env.VERIFY_CONTRACT ||
			'0x301C739CF6bfb6B47A74878BdEB13f92F13Ae5E7',
		PRIVATE_KEY: ethers.Wallet.createRandom().privateKey,
		UNLOCK_PER_TRANSACTION: '40',
		MAX_ROUND_AGE: '5',
		NO_GAS_OVERRIDE: 'true',
	});

	/* eslint-disable @typescript-eslint/no-var-requires */
	const { unlockPositions, getCurrentRound } = require('../blockchain');
	const { getUnlockablePositions } = require('../subgraph');

	const currentRound = await getCurrentRound();
	if (currentRound === undefined) {
		throw new Error('could not read currentRound - is the RPC reachable?');
	}
	console.log(`contract currentRound(): ${currentRound}\n`);

	// --- AC8: replay the incident shape -------------------------------------
	// Long-closed rounds, exactly what the corrupt subgraph reported.
	const stale: Record<string, string[]> = {};
	for (const round of [
		42, 44, 45, 46, 48, 49, 52, 54, 55, 56, 59, 61, 62, 65, 69, 70, 73,
	]) {
		stale[String(round)] = ['0x555306b8798b225ae92f6abd24e1d41ba62bcb53'];
	}
	// Fresh rounds carry no addresses, so they exercise the filter without
	// attempting a broadcast.
	stale[String(currentRound - 1)] = [];
	stale[String(currentRound - Number(process.env.MAX_ROUND_AGE))] = [];
	stale[String(currentRound - Number(process.env.MAX_ROUND_AGE) - 1)] = [];

	const summary = await unlockPositions(stale);
	const skipped = new Set<number>(summary.staleRoundsSkipped);

	check(
		'AC8 replay: no transactions sent',
		summary.transactionsSent === 0,
		`sent=${summary.transactionsSent}`,
	);
	check(
		'AC1 stale rounds refused',
		[42, 44, 45, 46, 48, 49, 52, 54, 55, 56, 59, 61, 62, 65, 69, 70, 73].every(
			r => skipped.has(r),
		),
		`skipped=${summary.staleRoundsSkipped.join(',')}`,
	);
	check('AC2 round at age 1 allowed', !skipped.has(currentRound - 1));
	check(
		'AC2 round at exactly MAX_ROUND_AGE allowed',
		!skipped.has(currentRound - Number(process.env.MAX_ROUND_AGE)),
	);
	check(
		'AC1 round one past MAX_ROUND_AGE refused',
		skipped.has(currentRound - Number(process.env.MAX_ROUND_AGE) - 1),
	);

	// --- AC6: a response with no _meta must be treated as unhealthy ----------
	reply = {
		data: { tokenLocks: [{ user: { id: '0xabc' }, untilRound: '1' }] },
	};
	const noMeta = await getUnlockablePositions();
	check(
		'AC6 missing _meta treated as unhealthy',
		noMeta === undefined,
		`got ${noMeta === undefined ? 'undefined' : JSON.stringify(noMeta)}`,
	);

	// A subgraph pinned far behind the head must also be refused.
	reply = { data: { tokenLocks: [], _meta: { block: { number: 1 } } } };
	const farBehind = await getUnlockablePositions();
	check('AC6 far-behind subgraph refused', farBehind === undefined);

	// --- healthy path still works -------------------------------------------
	const { getCurrentBlock } = require('../blockchain');
	const head = await getCurrentBlock();
	reply = {
		data: {
			tokenLocks: [{ user: { id: '0xAAA' }, untilRound: '7' }],
			_meta: { block: { number: head.number } },
		},
	};
	const healthy = await getUnlockablePositions();
	check(
		'healthy subgraph accepted',
		healthy !== undefined && healthy['7']?.length === 1,
		JSON.stringify(healthy),
	);

	server.close();

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
