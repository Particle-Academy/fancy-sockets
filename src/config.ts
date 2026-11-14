/**
 * App and server configuration, the defaults, and their validation.
 *
 * Every limit is a setting with a secure default. Validation runs on every
 * `addApp` / `updateApp`, so a bad value is refused at the API boundary instead
 * of surfacing later as a limit that silently does nothing.
 */

/** Limits that apply per app (and, for the per-socket ones, to each of its sockets). */
export interface AppLimits {
    /** Open connections for this app. Default 1000. */
    maxConnections: number;
    /** Channels one socket may be subscribed to. Default 100. */
    maxChannelsPerSocket: number;
    /** Distinct users in one presence channel. Default 100 (Pusher's limit). */
    maxPresenceMembers: number;
    /** Bytes of one incoming WebSocket message. Larger closes 1009. Default 10240. */
    maxMessageBytes: number;
    /** Bytes of `channel_data` on a presence subscription. Default 1024. */
    maxChannelDataBytes: number;
    /** Bytes of an event's `data`, from a client or the HTTP API. Default 10240. */
    maxEventBytes: number;
    /** Channels in one HTTP `events` call. Default 100. */
    maxEventChannels: number;
    /** Events in one HTTP `batch_events` call. Default 10. */
    maxBatchEvents: number;
    /** Messages per second one socket may send, any kind. Over closes 4301. Default 50. */
    messagesPerSecond: number;
    /** Client events per second one socket may send. Over is refused (4301). Default 10. */
    clientEventsPerSecond: number;
    /** HTTP API requests per second for this app. Over answers 429. Default 100. */
    apiRequestsPerSecond: number;
    /** Bytes queued for one socket before it is cut off as a slow consumer. Default 1 MiB. */
    maxBufferedBytes: number;
}

export interface AppConfig {
    id: string;
    key: string;
    secret: string;
    /** A disabled app refuses connections (4003) and API calls (403). Default true. */
    enabled?: boolean;
    /**
     * Client events (`client-*`) on private and presence channels. OFF by
     * default. Never allowed on public or encrypted channels.
     */
    clientEvents?: boolean;
    /** If set, a socket whose `Origin` header is not in the list is refused (4009). */
    allowedOrigins?: string[] | null;
    limits?: Partial<AppLimits>;
}

/** A validated app, every field present. */
export interface ResolvedApp {
    id: string;
    key: string;
    secret: string;
    enabled: boolean;
    clientEvents: boolean;
    allowedOrigins: string[] | null;
    limits: AppLimits;
}

export const DEFAULT_APP_LIMITS: Readonly<AppLimits> = Object.freeze({
    maxConnections: 1000,
    maxChannelsPerSocket: 100,
    maxPresenceMembers: 100,
    maxMessageBytes: 10_240,
    maxChannelDataBytes: 1024,
    maxEventBytes: 10_240,
    maxEventChannels: 100,
    maxBatchEvents: 10,
    messagesPerSecond: 50,
    clientEventsPerSecond: 10,
    apiRequestsPerSecond: 100,
    maxBufferedBytes: 1_048_576,
});

/** Process-wide limits. */
export interface GlobalLimits {
    /** Open WebSocket connections across all apps. Default 10000. */
    maxConnections: number;
    /** Hard cap on one WebSocket message for every app (the framing layer's limit). Default 65536. */
    maxMessageBytes: number;
    /** Bytes of an HTTP API request body. Default 102400. */
    maxBodyBytes: number;
    /** Time to receive a request's headers, including a WebSocket upgrade. Default 10000 ms. */
    headersTimeoutMs: number;
    /** Time to receive a whole HTTP request. Default 15000 ms. */
    requestTimeoutMs: number;
}

export const DEFAULT_GLOBAL_LIMITS: Readonly<GlobalLimits> = Object.freeze({
    maxConnections: 10_000,
    maxMessageBytes: 65_536,
    maxBodyBytes: 102_400,
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 15_000,
});

export class ConfigError extends Error {
    override name = 'ConfigError';
}

const ID = /^[A-Za-z0-9_\-.]{1,64}$/;
const KEY = /^[A-Za-z0-9_\-.]{1,128}$/;

function positiveInt(name: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new ConfigError(`${name} must be a positive integer.`);
    }
    return value;
}

export function resolveLimits<T extends object>(defaults: Readonly<T>, given: Partial<T> | undefined, label: string): T {
    const out = { ...defaults } as T;
    if (given === undefined) {
        return out;
    }
    if (given === null || typeof given !== 'object') {
        throw new ConfigError(`${label} must be an object.`);
    }
    for (const [name, value] of Object.entries(given)) {
        if (!Object.prototype.hasOwnProperty.call(defaults, name)) {
            throw new ConfigError(`${label}.${name} is not a known limit.`);
        }
        if (value === undefined) {
            continue;
        }
        (out as Record<string, number>)[name] = positiveInt(`${label}.${name}`, value);
    }
    return out;
}

/** Validates and fills an app. Error messages name the field, never a value: secrets end up in logs. */
export function resolveApp(app: AppConfig): ResolvedApp {
    if (app === null || typeof app !== 'object') {
        throw new ConfigError('An app must be an object.');
    }
    if (typeof app.id !== 'string' || !ID.test(app.id)) {
        throw new ConfigError('app.id must be 1-64 characters of A-Z a-z 0-9 _ - .');
    }
    if (typeof app.key !== 'string' || !KEY.test(app.key)) {
        throw new ConfigError(`app ${app.id}: key must be 1-128 characters of A-Z a-z 0-9 _ - .`);
    }
    if (typeof app.secret !== 'string' || app.secret.length < 8 || app.secret.length > 256) {
        throw new ConfigError(`app ${app.id}: secret must be 8-256 characters.`);
    }
    if (app.allowedOrigins !== undefined && app.allowedOrigins !== null && (!Array.isArray(app.allowedOrigins) || app.allowedOrigins.some((o) => typeof o !== 'string'))) {
        throw new ConfigError(`app ${app.id}: allowedOrigins must be a list of strings.`);
    }
    for (const flag of ['enabled', 'clientEvents'] as const) {
        if (app[flag] !== undefined && typeof app[flag] !== 'boolean') {
            throw new ConfigError(`app ${app.id}: ${flag} must be true or false.`);
        }
    }
    return {
        id: app.id,
        key: app.key,
        secret: app.secret,
        enabled: app.enabled ?? true,
        clientEvents: app.clientEvents ?? false,
        allowedOrigins: app.allowedOrigins ? [...app.allowedOrigins] : null,
        limits: resolveLimits(DEFAULT_APP_LIMITS, app.limits, `app ${app.id}: limits`),
    };
}
