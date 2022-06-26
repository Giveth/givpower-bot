import { request, gql } from 'graphql-request';
import config from './config';
import logger from './logger';
import contract from './contract';
import { ethers } from 'ethers';

export const getCurrentRound = async (): Promise<number> => {
  // const query = gql`
  //   query getMovie($address: String!) {
  //     givpower(id: $address) {
  //       initialDate
  //       roundDuration
  //     }
  //   }
  // `;
  //
  // const round = 0;
  // try {
  //   const response = await request(config.subgraphEndpoint, query, {
  //     address: config.givpowerContractAddress,
  //   });
  //
  //   logger.info(JSON.stringify(response, undefined, 2));
  // } catch (e) {
  //   logger.error('Error getting last round', e);
  // }
  let round = 0;

  try {
    const response = (await contract.currentRound()) as ethers.BigNumber;
    round = response.toNumber();
  } catch (e) {
    logger.error('Error on calling GIVpower contract currentRound', e);
  }

  return round;
};
