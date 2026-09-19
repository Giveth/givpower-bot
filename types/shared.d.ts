export interface UnlockablePositions {
	[round: string]: string[];
}

/** What happened to one unlock transaction. */
export interface UnlockOutcome {
	/**
	 * Whether the transaction left the client. A send that threw before
	 * broadcast consumed neither gas nor a nonce, so it must not be counted as
	 * an attempt or advance the nonce.
	 */
	broadcast: boolean;
	/** Whether a receipt was obtained. False when the wait timed out. */
	confirmed: boolean;
	/** Positions the chain confirmed unlocked, counted from TokenUnlocked events. */
	unlocked: number;
}

export interface UnlockRunSummary {
	/** Transactions actually broadcast this run - these are the ones that cost gas. */
	transactionsSent: number;
	/** Positions the chain confirmed as unlocked. */
	positionsUnlocked: number;
	/**
	 * Transactions that were broadcast but whose receipt never arrived within
	 * the wait timeout. They may yet confirm and do real work, so a run
	 * containing any of them cannot be judged ineffective.
	 */
	indeterminateTransactions: number;
	/** Rounds refused for being too far behind the current round. */
	staleRoundsSkipped: number[];
}
