import { BigNumber, ethers } from 'ethers';
import config from './config';
import * as GIVpowerArtifact from '../abi/GIVpower.json';
import logger from './logger';
import { UnlockablePositions } from '../types/shared';
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
		logger.error('Error on getting latest blo', e);
	}

	return currentBlock;
};

export const gwei2wei = (gweiAmount: number | string): ethers.BigNumber =>
	ethers.utils.parseUnits(gweiAmount.toString(), 'gwei');

const executeUnlockTransaction = async (
	nonce: number,
	round: string,
	userAddresses: string[],
) => {
	logger.debug(`Execute unlock, 
	nonce: ${nonce}, 
	round: ${round}
	userAddress: ${userAddresses}`);
	try {
		const tx = await contract.unlock(userAddresses, round, {
			nonce,
			maxFeePerGas: gwei2wei(config.gasMaxBaseFee),
			maxPriorityFeePerGas: gwei2wei(config.gasPriorityFee),
		});
		logger.info('Transaction hash:', tx.hash);
		const txResponse = await tx.wait();
		if (!txResponse.status) {
			logger.error(`Transaction ${tx.hash} failed!!`);
		} else {
			logger.info(`Transaction ${tx.hash} successfully executed`);
		}
	} catch (e) {
		logger.error('Error on executing unlock transaction', e);
	}
};

export const unlockPositions = async (
	unlockablePositions: UnlockablePositions,
) => {
	const rounds = Object.keys(unlockablePositions).sort(
		(_round1, _round2) => Number(_round1) - Number(_round2),
	);
	if (rounds.length === 0) {
		logger.info('No unlockable position to unlock');
	}
	let nonce = await signer.getTransactionCount('latest');
	for (const round of rounds) {
		const userAddresses: string[] = unlockablePositions[round];
		for (
			let i = 0;
			i < userAddresses.length;
			i = i + config.unlockPerTransaction
		) {
			const chunk = userAddresses.slice(
				i,
				i + config.unlockPerTransaction,
			);

			await executeUnlockTransaction(nonce, round, chunk);
			nonce += 1;
		}
	}
};
