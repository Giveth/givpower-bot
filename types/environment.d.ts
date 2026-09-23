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
			UNLOCK_PER_TRANSACTION: number;
			GAS_MAX_BASE_FEE: number;
			GAS_PRIORITY_FEE: number;
			MAX_ROUND_AGE: number;
			MAX_INEFFECTIVE_POLLS: number;
			SUBGRAPH_MAX_BLOCK_GAP: number;
			TX_WAIT_TIMEOUT_MS: number;
			DISCORD_ALERT_WEBHOOK_URL: string;
			DISCORD_ALERT_SOURCE_LABEL: string;
			DISCORD_ALERT_CHAIN_LABEL: string;
			DISCORD_ALERT_THROTTLE_MINUTES: number;
			DISCORD_ALERT_FAILURE_BACKOFF_MS: number;
			DISCORD_ALERT_ON_STARTUP: string;
			DISCORD_ALERT_MENTION_USER_IDS: string;
			DISCORD_ALERT_MENTION_ROLE_IDS: string;
			EXPLORER_BASE_URL: string;
			MIN_WALLET_BALANCE: number;
			SUBGRAPH_MISMATCH_SAMPLE_SIZE: number;
		}
	}
}
