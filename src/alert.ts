import config from './config';
import logger from './logger';

/**
 * Node 18 provides fetch globally, but @types/node is pinned at 18.0.0 here,
 * which predates the declaration. Declared locally rather than as an ambient
 * .d.ts so ts-node picks it up too - it only loads files reachable from the
 * entry point, so an ambient declaration would break `yarn start-dev`.
 */
declare const fetch: (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: unknown;
	},
) => Promise<{ ok: boolean; status: number; statusText: string }>;

declare const AbortSignal: { timeout?: (ms: number) => unknown } | undefined;

/** A silent endpoint otherwise holds the connection for minutes. */
const REQUEST_TIMEOUT_MS = 10_000;

export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AlertField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface AlertOptions {
	severity: AlertSeverity;
	title: string;
	description: string;
	fields?: AlertField[];
	/**
	 * Groups repeats of the same condition for throttling, so it should
	 * identify the thing being checked rather than the event that tripped it.
	 * A key that varies per occurrence (a transaction hash, say) defeats the
	 * throttle entirely.
	 */
	dedupeKey?: string;
	throttleMs?: number;
	mention?: boolean;
}

const SEVERITY_COLOR: Record<AlertSeverity, number> = {
	info: 0x3498db,
	warning: 0xf1c40f,
	error: 0xe74c3c,
	critical: 0x992d22,
};

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
	info: 'ℹ️',
	warning: '⚠️',
	error: '🚨',
	critical: '🔥',
};

// Discord's own limits.
const TITLE_LIMIT = 256;
/** Discord rejects more than 25 fields on an embed. */
const MAX_FIELDS = 25;
const MIN_THROTTLE_MS = 60_000;
const DESCRIPTION_LIMIT = 4000;
const FIELD_VALUE_LIMIT = 1024;

const truncate = (value: string, limit: number): string =>
	value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/**
 * One process per chain with no shared store, so an in-process Map is the
 * whole throttle mechanism. Keys are bounded in practice by the round-age
 * guard, which limits how many distinct rounds can be in play.
 *
 * Note this resets on restart, so a redeploy can re-post a standing
 * condition. That is the trade for not needing a shared store.
 */
const lastSentAt = new Map<string, number>();
const lastFailedAt = new Map<string, number>();

export const isAlertingConfigured = (): boolean =>
	Boolean(config.discordWebhookUrl);

const buildMentions = (): string => {
	const users = config.mentionUserIds.map(id => `<@${id}>`);
	const roles = config.mentionRoleIds.map(id => `<@&${id}>`);
	return [...users, ...roles].join(' ');
};

/**
 * Reports a fault condition: always logged, and posted to Discord when a
 * webhook is configured. Never throws and never blocks unlocking - a Discord
 * outage must not stop the bot doing its job.
 */
export const sendAlert = async (opts: AlertOptions): Promise<void> => {
	const logLine = `[${opts.severity}] ${opts.title} - ${opts.description}`;
	if (opts.severity === 'info') {
		logger.info(logLine);
	} else if (opts.severity === 'warning') {
		logger.warn(logLine);
	} else {
		logger.error(logLine);
	}

	if (!config.discordWebhookUrl) return;

	const dedupeKey = opts.dedupeKey ?? `${opts.severity}:${opts.title}`;
	// Floored: a configured 0 would otherwise mean "post every poll", which is
	// the storm the throttle exists to prevent.
	const throttleMs = Math.max(
		MIN_THROTTLE_MS,
		opts.throttleMs ?? config.alertThrottleMs,
	);
	const now = Date.now();

	const previous = lastSentAt.get(dedupeKey);
	if (previous !== undefined && now - previous < throttleMs) return;

	// After a failed send, stay quiet briefly. Without this, a Discord outage
	// during a poll that emits one alert per chunk becomes one slow failing
	// request per chunk, all inside a single poll. The throttle window itself
	// is deliberately left unconsumed, so the condition can still be reported
	// once Discord recovers.
	const failedAt = lastFailedAt.get(dedupeKey);
	if (failedAt !== undefined && now - failedAt < config.alertFailureBackoffMs) {
		return;
	}

	const shouldMention =
		opts.mention ?? (opts.severity === 'error' || opts.severity === 'critical');
	const mentions = shouldMention ? buildMentions() : '';

	const body = {
		content: mentions || undefined,
		allowed_mentions: {
			users: shouldMention ? config.mentionUserIds : [],
			roles: shouldMention ? config.mentionRoleIds : [],
		},
		embeds: [
			{
				title: truncate(
					`${SEVERITY_EMOJI[opts.severity]} ${opts.title}`,
					TITLE_LIMIT,
				),
				description: truncate(opts.description, DESCRIPTION_LIMIT),
				color: SEVERITY_COLOR[opts.severity],
				fields: (opts.fields ?? []).slice(0, MAX_FIELDS).map(field => ({
					name: truncate(field.name, TITLE_LIMIT),
					value: truncate(field.value, FIELD_VALUE_LIMIT),
					inline: field.inline ?? false,
				})),
				footer: {
					text: `${config.discordSourceLabel} • ${config.chainLabel} • ${(
						process.env.NODE_ENV || 'develop'
					).toUpperCase()}`,
				},
				timestamp: new Date(now).toISOString(),
			},
		],
	};

	try {
		const response = await fetch(config.discordWebhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal?.timeout?.(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			lastFailedAt.set(dedupeKey, now);
			logger.warn(
				`Failed to post alert "${dedupeKey}" to Discord: ${response.status} ${response.statusText}`,
			);
			return;
		}
		lastFailedAt.delete(dedupeKey);
		// Stamped only on a successful send, so an outage cannot silently eat
		// the whole throttle window.
		lastSentAt.set(dedupeKey, now);
	} catch (e) {
		lastFailedAt.set(dedupeKey, now);
		logger.warn(`Failed to post alert "${dedupeKey}" to Discord: ${e}`);
	}
};
