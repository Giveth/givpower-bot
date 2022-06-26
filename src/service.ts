import logger from './logger';
import { getCurrentRound } from './subgraph';

const service = async () => {
  const currentRound = await getCurrentRound();
  logger.info('current round:', currentRound);
};

export default service;
