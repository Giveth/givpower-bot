import logger from './logger';
import { getCurrentRound, unlockPositions } from './blockchain';
import { getUnlockablePositions } from './subgraph';

const service = async () => {
	const positions = await getUnlockablePositions();
	logger.info(positions);
	if (positions) await unlockPositions(positions);
};

export default service;
