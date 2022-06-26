import { ethers } from 'ethers';
import config from './config';
import * as GIVpowerArtifact from '../abi/GIVpower.json';

const { abi: GIVpowerABI } = GIVpowerArtifact;
const { privateKey, givpowerContractAddress, nodeUrl } = config;
const provider = new ethers.providers.JsonRpcProvider(nodeUrl);
const signer = new ethers.Wallet(privateKey, provider);

const contract = new ethers.Contract(
  givpowerContractAddress,
  GIVpowerABI,
  signer,
);

export default contract;
