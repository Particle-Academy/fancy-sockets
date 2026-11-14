/**
 * The Pusher protocol's pure parts: signatures, names, codes. No I/O.
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Close and error codes from the Pusher protocol (and 1009 from RFC 6455). */
export const CODES = {
    /** RFC 6455: message too big. */
    messageTooBig: 1009,
    /** RFC 6455: unsupported data (a binary frame). */
    unsupportedData: 1003,
    /** No reconnect: the app does not exist (or was removed). */
    appNotFound: 4001,
    /** No reconnect: the app is disabled. */
    appDisabled: 4003,
    /** No reconnect: the app is over its connection quota. */
    overQuota: 4004,
    /** No reconnect: path not found. */
    pathNotFound: 4005,
    /** No reconnect: invalid protocol version. */
    invalidVersion: 4006,
    /** No reconnect: unauthorized (origin refused). */
    unauthorized: 4009,
    /** Reconnect with backoff: over capacity (process-wide cap, slow consumer). */
    overCapacity: 4100,
    /** Reconnect immediately: generic (server stopping, app credentials changed). */
    reconnect: 4200,
    /** Reconnect immediately: pong not received. */
    pongTimeout: 4201,
    /** Client event or message rejected for rate. */
    rateLimited: 4301,
} as const;

/** Pusher channel names: 1-200 of these characters. `#` (server-to-user) is not allowed. */
const CHANNEL = /^[A-Za-z0-9_\-=@,.;]{1,200}$/;

export type ChannelType = 'public' | 'private' | 'encrypted' | 'presence';

export function channelType(name: string): ChannelType {
    if (name.startsWith('private-encrypted-')) {
        return 'encrypted';
    }
    if (name.startsWith('private-')) {
        return 'private';
    }
    if (name.startsWith('presence-')) {
        return 'presence';
    }
    return 'public';
}

export function isValidChannelName(name: unknown): name is string {
    return typeof name === 'string' && CHANNEL.test(name);
}

export function isValidEventName(name: unknown): name is string {
    return typeof name === 'string' && name.length > 0 && name.length <= 200;
}

/** `123.456`, both parts random positive 31-bit integers. */
export function newSocketId(): string {
    return `${randomInt(1, 2 ** 31 - 1)}.${randomInt(1, 2 ** 31 - 1)}`;
}

export const SOCKET_ID = /^\d{1,20}\.\d{1,20}$/;

function hmac(secret: string, subject: string): string {
    return createHmac('sha256', secret).update(subject, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex strings (length is not secret). */
export function safeEqualHex(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
        return false;
    }
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The channel authorisation a host's auth endpoint returns:
 * `key:HMAC-SHA256(secret, "socket_id:channel[:channel_data]")`.
 */
export function signChannel(key: string, secret: string, socketId: string, channel: string, channelData?: string): string {
    const subject = channelData === undefined ? `${socketId}:${channel}` : `${socketId}:${channel}:${channelData}`;
    return `${key}:${hmac(secret, subject)}`;
}

/** Checks a subscription's `auth` field against the app's key and secret. */
export function verifyChannel(key: string, secret: string, socketId: string, channel: string, auth: unknown, channelData?: string): boolean {
    if (typeof auth !== 'string') {
        return false;
    }
    const colon = auth.indexOf(':');
    if (colon < 1 || auth.slice(0, colon) !== key) {
        return false;
    }
    const expected = signChannel(key, secret, socketId, channel, channelData).slice(key.length + 1);
    return safeEqualHex(auth.slice(colon + 1).toLowerCase(), expected);
}

/**
 * The HTTP API string to sign: `METHOD\nPATH\nquery`, where the query is every
 * parameter except `auth_signature`, names lowercased and sorted, joined
 * unencoded as `name=value&...`.
 */
export function apiStringToSign(method: string, path: string, params: Record<string, string>): string {
    const names = Object.keys(params)
        .filter((n) => n !== 'auth_signature')
        .sort();
    const query = names.map((n) => `${n}=${params[n]}`).join('&');
    return `${method.toUpperCase()}\n${path}\n${query}`;
}

export function signApiRequest(secret: string, method: string, path: string, params: Record<string, string>): string {
    return hmac(secret, apiStringToSign(method, path, params));
}

export function md5(body: Buffer | string): string {
    return createHash('md5').update(body).digest('hex');
}

/**
 * Builds the signed query for an HTTP API call, as a publisher does. Exported
 * for Node hosts and tests; the server never calls it.
 */
export function signedApiQuery(key: string, secret: string, method: string, path: string, body: string | undefined, extra: Record<string, string> = {}, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
    const params: Record<string, string> = { ...extra, auth_key: key, auth_timestamp: String(timestamp), auth_version: '1.0' };
    if (body !== undefined && body !== '') {
        params.body_md5 = md5(body);
    }
    params.auth_signature = signApiRequest(secret, method, path, params);
    return params;
}

/**
 * A token bucket: `rate` per second, burst `rate`. Refilled lazily from a
 * monotonic clock, so a bucket costs nothing while idle and needs no timer.
 */
export class RateLimiter {
    #tokens: number;
    #last: number;

    constructor(
        public rate: number,
        private readonly now: () => number = () => performance.now(),
    ) {
        this.#tokens = rate;
        this.#last = this.now();
    }

    take(): boolean {
        const t = this.now();
        this.#tokens = Math.min(this.rate, this.#tokens + ((t - this.#last) / 1000) * this.rate);
        this.#last = t;
        if (this.#tokens >= 1) {
            this.#tokens -= 1;
            return true;
        }
        return false;
    }
}
