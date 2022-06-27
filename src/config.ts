import * as dotenv from 'dotenv';
import path from 'path';
import logger from './logger';

dotenv.config({
	path: path.resolve(
		__dirname,
		`../config/${process.env.NODE_ENV || ''}.env`,
	),
});

if (!process.env.GIVPOWER_CONTRACT_ADDRESS) {
	logger.error('GIVPOWER_CONTRACT_ADDRESS is not defined');
	process.exit(-1);
}

if (!process.env.SUBGRAPH_ENDPOINT) {
	logger.error('SUBGRAPH_ENDPOINT is not defined');
	process.exit(-1);
}

const config: {
	nodeUrl: string;
	pollPeriodSecond: number;
	subgraphEndpoint: string;
	givpowerContractAddress: string;
	privateKey: string;
	unlockPerTransaction: number;
	gasMaxBaseFee: number;
	gasPriorityFee: number;
} = {
	nodeUrl: process.env.NODE_URL || 'https://rpc.gnosischain.com/',
	pollPeriodSecond: Number(process.env.POLL_PERIOD_SECOND) || 60,
	subgraphEndpoint: process.env.SUBGRAPH_ENDPOINT,
	givpowerContractAddress: process.env.GIVPOWER_CONTRACT_ADDRESS,
	privateKey: process.env.PRIVATE_KEY || '',
	unlockPerTransaction: Number(process.env.UNLOCK_PER_TRANSACTION) || 1,
	gasMaxBaseFee: Number(process.env.GAS_MAX_BASE_FEE) || 2,
	gasPriorityFee: Number(process.env.GAS_PRIORITY_FEE) || 2,
};

export default config;
