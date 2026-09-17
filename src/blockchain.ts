import { ethers } from 'ethers';
import config from './config';
import * as GIVpowerArtifact from '../abi/GIVpower.json';
import logger from './logger';
import {
	UnlockablePositions,
	UnlockOutcome,
	UnlockRunSummary,
} from '../types/shared';
import { GIVpower } from '../types/contracts/GIVpower';
import { sendAlert } from './alert';

const { abi: GIVpowerABI } = GIVpowerArtifact;
const { privateKey, givpowerContractAddress, nodeUrl } = config;
const provider = new ethers.providers.JsonRpcProvider(nodeUrl);
const signer = new ethers.Wallet(privateKey, provider);

const contract = new ethers.Contract(
	givpowerContractAddress,
	GIVpowerABI,
	signer,
) as GIVpower;

/**
 * Emitted by GIVpower/UnipoolGIVpower once per position that was really
 * unlocked. Derived from the signature rather than the bundled ABI because
 * abi/GIVpower.json predates this event and does not declare it.
 */
const TOKEN_UNLOCKED_TOPIC = ethers.utils.id(
	'TokenUnlocked(address,uint256,uint256)',
);

const contractAddressLower = givpowerContractAddress.toLowerCase();

/**
 * abi/GIVpower.json declares lockedTokens and _powerUntilRound, neither of
 * which exists on the deployed contract, and omits userLocks, which does.
 * Reading it off `contract` compiles (the generated typechain types disagree
 * with the bundled ABI) but is undefined at runtime, so attach a minimal
 * fragment instead. userLocks(user) is that user's totalAmountLocked.
 */
const lockReader = new ethers.Contract(
	givpowerContractAddress,
	['function userLocks(address) view returns (uint256)'],
	provider,
);

/**
 * How many rounds must have passed before a disagreement can be blamed on the
 * subgraph rather than on it not having indexed the bot's own work yet.
 */
const SETTLED_ROUND_LAG = 2;

const explorerTxLink = (hash: string): string =>
	config.explorerBaseUrl ? `${config.explorerBaseUrl}/tx/${hash}` : hash;

export const getCurrentRound = async (): Promise<number | undefined> => {
	let currentRound;
	try {
		const response = (await contract.currentRound()) as ethers.BigNumber;
		currentRound = response.toNumber();
	} catch (e) {
		logger.error('Error on calling GIVpower contract currentRound', e);
	}

	return currentRound;
};

export const getCurrentBlock = async (): Promise<
	ethers.providers.Block | undefined
> => {
	let currentBlock;
	try {
		currentBlock = await provider.getBlock('latest');
	} catch (e) {
		logger.error('Error on getting latest block', e);
	}

	return currentBlock;
};

export const gwei2wei = (gweiAmount: number | string): ethers.BigNumber =>
	ethers.utils.parseUnits(gweiAmount.toString(), 'gwei');

/**
 * Sends one unlock transaction and reports what became of it.
 *
 * `unlock()` skips any position that has nothing left to unlock without
 * reverting, so a receipt with `status: 1` does not mean work was done. Only
 * the TokenUnlocked events tell us that, and callers rely on the count to
 * notice when the bot is burning gas for nothing.
 */
const executeUnlockTransaction = async (
	nonce: number,
	round: string,
	userAddresses: string[],
): Promise<UnlockOutcome> => {
	logger.debug(`Execute unlock, 
	nonce: ${nonce}, 
	round: ${round}
	userAddress: ${userAddresses}`);
	const maxFeePerGas = !config.noGasOverride
		? gwei2wei(config.gasMaxBaseFee)
		: undefined;
	const maxPriorityFeePerGas = !config.noGasOverride
		? gwei2wei(config.gasPriorityFee)
		: undefined;

	let tx;
	try {
		tx = await contract.unlock(userAddresses, round, {
			nonce,
			maxFeePerGas,
			maxPriorityFeePerGas,
		});
	} catch (e) {
		// Nothing was broadcast, so this nonce is still free and no gas was
		// spent. Reporting it as an attempt would let an RPC outage or an empty
		// wallet trip the ineffective-poll guard.
		logger.error(
			`Could not send unlock transaction for round ${round} (nonce ${nonce})`,
			e,
		);
		return { broadcast: false, confirmed: false, unlocked: 0 };
	}

	logger.info('Transaction hash:', tx.hash);

	let receipt: ethers.providers.TransactionReceipt | null = null;
	try {
		// Bounded, unlike tx.wait(): the poll loop is serial now, so an
		// unmineable transaction would otherwise stop the bot polling forever
		// while the container still looks healthy.
		receipt = await provider.waitForTransaction(
			tx.hash,
			1,
			config.txWaitTimeoutMs,
		);
	} catch (e) {
		logger.error(
			`Gave up waiting for transaction ${tx.hash} after ${config.txWaitTimeoutMs}ms.
			It may still be pending - the nonce is spent either way.`,
			e,
		);
		return { broadcast: true, confirmed: false, unlocked: 0 };
	}

	if (!receipt || !receipt.status) {
		logger.error(`Transaction ${tx.hash} failed!!`);
		return { broadcast: true, confirmed: true, unlocked: 0 };
	}

	const unlocked = receipt.logs.filter(
		log =>
			log.address.toLowerCase() === contractAddressLower &&
			log.topics[0] === TOKEN_UNLOCKED_TOPIC,
	).length;

	if (unlocked === 0) {
		await sendAlert({
			severity: 'error',
			title: 'Unlock transaction did nothing',
			description:
				'The transaction succeeded but emitted no TokenUnlocked events, so ' +
				'the chain considers these positions already unlocked. The subgraph ' +
				'is reporting stale data and gas was spent for no effect.',
			fields: [
				{ name: 'Round', value: String(round), inline: true },
				{
					name: `Addresses (${userAddresses.length})`,
					value: userAddresses.join('\n'),
				},
				{ name: 'Transaction', value: `\`${tx.hash}\`` },
				...(config.explorerBaseUrl
					? [{ name: 'Explorer', value: explorerTxLink(tx.hash) }]
					: []),
			],
			// Keyed on the round, not the hash: every poll produces a fresh hash,
			// so a per-hash key would post on every poll forever.
			dedupeKey: `junk-tx:${round}`,
		});
	} else {
		logger.info(`Transaction ${tx.hash} unlocked ${unlocked} position(s)`);
	}

	return { broadcast: true, confirmed: true, unlocked };
};

export const unlockPositions = async (
	unlockablePositions: UnlockablePositions,
	currentRound: number,
): Promise<UnlockRunSummary> => {
	const summary: UnlockRunSummary = {
		transactionsSent: 0,
		positionsUnlocked: 0,
		indeterminateTransactions: 0,
		staleRoundsSkipped: [],
	};

	const rounds = Object.keys(unlockablePositions).sort(
		(_round1, _round2) => Number(_round1) - Number(_round2),
	);
	if (rounds.length === 0) {
		logger.info('No unlockable position to unlock');
		return summary;
	}

	// Drop rounds that closed long ago. They are the signature of a subgraph
	// that never marked old locks as unlocked, and unlocking them is a no-op.
	const roundsToUnlock: string[] = [];
	for (const round of rounds) {
		if (currentRound - Number(round) > config.maxRoundAge) {
			summary.staleRoundsSkipped.push(Number(round));
		} else {
			roundsToUnlock.push(round);
		}
	}

	if (summary.staleRoundsSkipped.length > 0) {
		logger.error(`Refusing to unlock ${
			summary.staleRoundsSkipped.length
		} round(s) that closed more than ${config.maxRoundAge} rounds ago.
		Current round: ${currentRound}
		Skipped rounds: ${summary.staleRoundsSkipped.join(', ')}
		These positions are almost certainly unlocked on chain already and the
		subgraph is out of sync. Check SUBGRAPH_ENDPOINT before raising
		MAX_ROUND_AGE.`);
	}

	// 'pending' rather than 'latest' so a still-unmined batch does not make the
	// next run reuse the same nonces.
	let nonce = await signer.getTransactionCount('pending');
	for (const round of roundsToUnlock) {
		const userAddresses: string[] = unlockablePositions[round];
		for (
			let i = 0;
			i < userAddresses.length;
			i = i + config.unlockPerTransaction
		) {
			const chunk = userAddresses.slice(i, i + config.unlockPerTransaction);
			const outcome = await executeUnlockTransaction(nonce, round, chunk);

			// A send that never left the client leaves the nonce free; advancing
			// it anyway would queue every later transaction at an unreachable
			// nonce.
			if (outcome.broadcast) {
				summary.transactionsSent += 1;
				summary.positionsUnlocked += outcome.unlocked;
				if (!outcome.confirmed) {
					summary.indeterminateTransactions += 1;
				}
				nonce += 1;
			}
		}
	}

	return summary;
};

/**
 * Reports a wallet that can no longer pay for its own work. Checked every poll
 * regardless of whether there is anything to unlock - the Gnosis instance sat
 * empty for 12 days precisely because nothing was watching when it was idle.
 */
export const checkWalletBalance = async (): Promise<void> => {
	let balance: ethers.BigNumber;
	try {
		balance = await signer.getBalance();
	} catch (e) {
		logger.error('Could not read bot wallet balance', e);
		return;
	}

	let minimum: ethers.BigNumber;
	try {
		// toFixed rather than String: a small value stringifies to exponential
		// notation ("1e-7"), which parseUnits rejects. An unusable alerting
		// setting must not throw into the unlock path.
		minimum = ethers.utils.parseUnits(config.minWalletBalance.toFixed(18), 18);
	} catch (e) {
		logger.error(
			`MIN_WALLET_BALANCE (${config.minWalletBalance}) is not a usable amount`,
			e,
		);
		return;
	}
	if (balance.gte(minimum)) return;

	await sendAlert({
		severity: 'error',
		title: 'GIVpower bot wallet is low',
		description:
			'The bot cannot keep paying for unlock transactions. Once it runs out, ' +
			'positions stop being unlocked and nothing else reports it.',
		fields: [
			{ name: 'Address', value: signer.address },
			{
				name: 'Balance',
				value: ethers.utils.formatEther(balance),
				inline: true,
			},
			{
				name: 'Minimum',
				value: String(config.minWalletBalance),
				inline: true,
			},
		],
		dedupeKey: 'wallet-low',
	});
};

/**
 * Checks a sample of the positions the subgraph claims are unlockable against
 * the chain, before any gas is spent.
 *
 * The contract exposes no per-round balance - `userLocks` is the user's total
 * across every round, and `_powerUntilRound` reverts on the deployed contract
 * - so this can only ever prove the subgraph wrong, never right. A user whose
 * total is zero cannot have anything to unlock in any round, so the subgraph
 * is definitely wrong about them. A user still holding a live lock reads
 * non-zero and is not flagged even when this particular position is phantom.
 * It is a sufficient signal, not a complete one; the stale-round refusal and
 * the junk-transaction alert cover the rest.
 *
 * Rounds the bot is actively working are excluded. It unlocks them and the
 * subgraph takes a moment to index that, so a freshly emptied user would
 * otherwise be reported as a mismatch every time the bot did its job.
 *
 * Returns the users that disagreed.
 */
export const findSubgraphChainMismatches = async (
	positions: UnlockablePositions,
	currentRound: number,
	deployment?: string,
): Promise<string[]> => {
	const sampleSize = Math.max(0, Math.floor(config.mismatchSampleSize));
	if (sampleSize === 0) return [];

	const settledRounds = Object.keys(positions).filter(
		round => currentRound - Number(round) >= SETTLED_ROUND_LAG,
	);

	const users = Array.from(
		new Set(
			settledRounds.reduce<string[]>(
				(all, round) => all.concat(positions[round] || []),
				[],
			),
		),
	).slice(0, sampleSize);

	if (users.length === 0) return [];

	const mismatched: string[] = [];
	for (const user of users) {
		try {
			const locked = (await lockReader.userLocks(user)) as ethers.BigNumber;
			if (locked.isZero()) mismatched.push(user);
		} catch (e) {
			logger.warn(`Could not read userLocks for ${user}`, e);
		}
	}

	if (mismatched.length > 0) {
		await sendAlert({
			// Warning rather than critical: this proves the subgraph wrong but
			// cannot measure how wrong, and it does not by itself mean gas is
			// being wasted - the guards may already be refusing these rounds.
			severity: 'warning',
			title: 'Subgraph disagrees with the chain',
			description:
				`${mismatched.length} of ${users.length} sampled positions are ` +
				'reported unlockable by the subgraph but hold nothing on chain. ' +
				'The subgraph index is wrong; unlocking these would only burn gas.',
			fields: [
				{
					name: 'Mismatched',
					value: `${mismatched.length}/${users.length}`,
					inline: true,
				},
				{ name: 'Deployment', value: deployment || 'unknown', inline: true },
				{ name: 'Example user', value: mismatched[0] },
			],
			dedupeKey: 'subgraph-mismatch',
		});
	}

	return mismatched;
};
