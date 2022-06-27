import logger from './logger';
import { getCurrentRound } from './blockchain';
import { getUnlockablePositions } from './subgraph';

const service = async () => {
	const positions = await getUnlockablePositions();
	logger.info(positions);
};

export default service;
