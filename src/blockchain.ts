import { ethers } from 'ethers';
import config from './config';
import * as GIVpowerArtifact from '../abi/GIVpower.json';
import logger from './logger';

const { abi: GIVpowerABI } = GIVpowerArtifact;
const { privateKey, givpowerContractAddress, nodeUrl } = config;
const provider = new ethers.providers.JsonRpcProvider(nodeUrl);
const signer = new ethers.Wallet(privateKey, provider);

const blockchain = new ethers.Contract(
	givpowerContractAddress,
	GIVpowerABI,
	signer,
);

export const getCurrentRound = async (): Promise<number | undefined> => {
	let currentRound;
	try {
		const response = (await blockchain.currentRound()) as ethers.BigNumber;
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
