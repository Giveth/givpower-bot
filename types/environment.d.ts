export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_URL: string;
      NODE_ENV: 'develop' | 'production';
      POLL_PERIOD_SECOND: number;
      SUBGRAPH_ENDPOINT: string;
      GIVPOWER_CONTRACT_ADDRESS: string;
      PRIVATE_KEY: string;
    }
  }
}
