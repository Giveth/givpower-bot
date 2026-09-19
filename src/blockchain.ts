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
		logger.error(`Transaction ${tx.hash} succeeded but unlocked nothing.
		Round: ${round}
		Addresses: ${userAddresses}
		The chain considers these positions already unlocked, so the subgraph
		is reporting stale data. Gas was spent for no effect.`);
	} else {
		logger.info(`Transaction ${tx.hash} unlocked ${unlocked} position(s)`);
	}

	return { broadcast: true, confirmed: true, unlocked };
};

export const unlockPositions = async (
	unlockablePositions: UnlockablePositions,
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

	const currentRound = await getCurrentRound();
	if (currentRound === undefined) {
		logger.error(
			'Skipping unlock run: could not read currentRound from the contract',
		);
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
