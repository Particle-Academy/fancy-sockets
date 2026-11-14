/**
 * The Pusher HTTP API: events, batch events, and channel / user queries.
 *
 * Order of checks is deliberate and cheapest-first, and NOTHING is parsed
 * before the request is authenticated: the route, then the app, then the rate
 * budget, then the body (read under a byte cap), then the signature over the
 * query and the body's md5. Only an authenticated body is JSON-parsed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { md5, safeEqualHex, signApiRequest, isValidChannelName, isValidEventName, SOCKET_ID } from './protocol.js';
import type { AppState, Socket } from './state.js';

export interface ApiHost {
    findApp(id: string): AppState | undefined;
    maxBodyBytes: number;
    now(): number;
    refuse(kind: string): void;
    /** Publishes one serialised frame to a channel's sockets, except `except`. */
    publish(app: AppState, channel: string, frame: string, except: Socket | undefined): void;
    socketById(app: AppState, id: string): Socket | undefined;
}

const TIMESTAMP_WINDOW_S = 600;
const ROUTE = /^\/apps\/([^/]+)\/(events|batch_events|channels)(?:\/([^/]+)(?:\/(users))?)?$/;

function reply(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
}

function readBody(req: IncomingMessage, cap: number): Promise<Buffer | 'too-large'> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > cap) {
            resolve('too-large');
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        req.on('data', (chunk: Buffer) => {
            if (done) {
                return;
            }
            size += chunk.length;
            if (size > cap) {
                done = true;
                resolve('too-large');
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!done) {
                done = true;
                resolve(Buffer.concat(chunks));
            }
        });
        req.on('error', (err) => {
            if (!done) {
                done = true;
                reject(err);
            }
        });
    });
}

/** Query parameters with lowercased names; a repeated name is refused (ambiguous to sign). */
function params(url: URL): Record<string, string> | null {
    const out: Record<string, string> = Object.create(null);
    for (const [rawName, value] of url.searchParams) {
        const name = rawName.toLowerCase();
        if (name in out) {
            return null;
        }
        out[name] = value;
    }
    return out;
}

interface EventInput {
    name: unknown;
    data: unknown;
    channels?: unknown;
    channel?: unknown;
    socket_id?: unknown;
}

/** Returns an error message, or the channels to publish to. */
function validateEvent(app: AppState, event: EventInput, batch: boolean): string | { channels: string[]; data: string; name: string; socketId?: string } {
    if (event === null || typeof event !== 'object') {
        return 'An event must be an object.';
    }
    if (!isValidEventName(event.name)) {
        return 'Invalid event name.';
    }
    if (typeof event.data !== 'string') {
        return 'Event data must be a string.';
    }
    if (Buffer.byteLength(event.data) > app.config.limits.maxEventBytes) {
        return 'too-large';
    }
    let channels: unknown = batch ? [event.channel] : (event.channels ?? (event.channel !== undefined ? [event.channel] : undefined));
    if (!Array.isArray(channels) || channels.length === 0) {
        return 'An event needs channels.';
    }
    if (channels.length > app.config.limits.maxEventChannels) {
        return `At most ${app.config.limits.maxEventChannels} channels per event.`;
    }
    if (!channels.every(isValidChannelName)) {
        return 'Invalid channel name.';
    }
    channels = [...new Set(channels as string[])];
    let socketId: string | undefined;
    if (event.socket_id !== undefined) {
        if (typeof event.socket_id !== 'string' || !SOCKET_ID.test(event.socket_id)) {
            return 'Invalid socket_id.';
        }
        socketId = event.socket_id;
    }
    return { channels: channels as string[], data: event.data, name: event.name, socketId };
}

export async function handleApi(host: ApiHost, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = ROUTE.exec(url.pathname);
    if (route === null) {
        return false;
    }
    const [, rawId, kind, rawChannel, users] = route;
    let appId: string;
    let channelName: string | undefined;
    try {
        appId = decodeURIComponent(rawId!);
        channelName = rawChannel === undefined ? undefined : decodeURIComponent(rawChannel);
    } catch {
        reply(res, 400, { error: 'Malformed path.' });
        return true;
    }
    const method = req.method ?? 'GET';
    const isPost = kind === 'events' || kind === 'batch_events';
    if ((isPost && (method !== 'POST' || rawChannel !== undefined)) || (!isPost && method !== 'GET')) {
        reply(res, 405, { error: 'Method not allowed.' });
        return true;
    }

    const app = host.findApp(appId);
    if (app === undefined) {
        host.refuse('api.app');
        reply(res, 404, { error: 'Unknown app.' });
        return true;
    }
    if (!app.config.enabled) {
        host.refuse('api.disabled');
        reply(res, 403, { error: 'App is disabled.' });
        return true;
    }
    if (!app.api.take()) {
        host.refuse('api.rate');
        reply(res, 429, { error: 'Rate limit exceeded.' });
        return true;
    }

    const body = isPost ? await readBody(req, host.maxBodyBytes) : Buffer.alloc(0);
    if (body === 'too-large') {
        host.refuse('api.body');
        reply(res, 413, { error: 'Request body too large.' });
        req.resume();
        return true;
    }

    // ---- authenticate: nothing above this line trusted the request.
    const query = params(url);
    if (query === null) {
        host.refuse('api.auth');
        reply(res, 400, { error: 'Repeated query parameter.' });
        return true;
    }
    const auth = authenticate(host, app, method, url.pathname, query, body);
    if (auth !== null) {
        host.refuse('api.auth');
        reply(res, 401, { error: auth });
        return true;
    }

    if (kind === 'channels') {
        channelsQuery(app, res, query, channelName, users !== undefined);
        return true;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(body.toString('utf8'));
    } catch {
        reply(res, 400, { error: 'Malformed JSON.' });
        return true;
    }
    const events: EventInput[] = kind === 'events' ? [parsed as EventInput] : ((parsed as { batch?: unknown })?.batch as EventInput[]);
    if (kind === 'batch_events' && (!Array.isArray(events) || events.length === 0)) {
        reply(res, 400, { error: 'batch must be a non-empty list.' });
        return true;
    }
    if (events.length > app.config.limits.maxBatchEvents) {
        reply(res, 400, { error: `At most ${app.config.limits.maxBatchEvents} events per batch.` });
        return true;
    }
    // Validate all before publishing any: a batch is all-or-nothing.
    const valid = [];
    for (const event of events) {
        const result = validateEvent(app, event, kind === 'batch_events');
        if (result === 'too-large') {
            host.refuse('api.event-size');
            reply(res, 413, { error: 'Event data too large.' });
            return true;
        }
        if (typeof result === 'string') {
            reply(res, 400, { error: result });
            return true;
        }
        valid.push(result);
    }
    for (const event of valid) {
        const except = event.socketId === undefined ? undefined : host.socketById(app, event.socketId);
        for (const channel of event.channels) {
            host.publish(app, channel, JSON.stringify({ event: event.name, channel, data: event.data }), except);
        }
    }
    reply(res, 200, kind === 'batch_events' ? { batch: valid.map(() => ({})) } : {});
    return true;
}

function authenticate(host: ApiHost, app: AppState, method: string, path: string, query: Record<string, string>, body: Buffer): string | null {
    if (query.auth_key !== app.config.key) {
        return 'Invalid auth_key.';
    }
    if (query.auth_version !== '1.0') {
        return 'Invalid auth_version.';
    }
    const ts = Number(query.auth_timestamp);
    if (!/^\d{1,12}$/.test(query.auth_timestamp ?? '') || Math.abs(host.now() - ts) > TIMESTAMP_WINDOW_S) {
        return 'Timestamp expired or missing.';
    }
    if (body.length > 0 || query.body_md5 !== undefined) {
        if (!safeEqualHex((query.body_md5 ?? '').toLowerCase(), md5(body))) {
            return 'Invalid body_md5.';
        }
    }
    const expected = signApiRequest(app.config.secret, method, path, query);
    if (!safeEqualHex((query.auth_signature ?? '').toLowerCase(), expected)) {
        return 'Invalid signature.';
    }
    return null;
}

function infoFields(query: Record<string, string>): Set<string> {
    return new Set((query.info ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function channelsQuery(app: AppState, res: ServerResponse, query: Record<string, string>, channelName: string | undefined, users: boolean): void {
    const info = infoFields(query);
    if (channelName === undefined) {
        const prefix = query.filter_by_prefix ?? '';
        if (info.has('user_count') && !prefix.startsWith('presence-')) {
            reply(res, 400, { error: 'user_count needs filter_by_prefix=presence-.' });
            return;
        }
        const channels: Record<string, unknown> = Object.create(null);
        for (const [name, channel] of app.channels) {
            if (channel.sockets.size > 0 && name.startsWith(prefix)) {
                channels[name] = info.has('user_count') && channel.type === 'presence' ? { user_count: channel.users.size } : {};
            }
        }
        reply(res, 200, { channels });
        return;
    }
    if (!isValidChannelName(channelName)) {
        reply(res, 400, { error: 'Invalid channel name.' });
        return;
    }
    const channel = app.channels.get(channelName);
    if (users) {
        if (!channelName.startsWith('presence-')) {
            reply(res, 400, { error: 'Users are only available for presence channels.' });
            return;
        }
        reply(res, 200, { users: channel === undefined ? [] : [...channel.users.keys()].map((id) => ({ id })) });
        return;
    }
    if (info.has('user_count') && !channelName.startsWith('presence-')) {
        reply(res, 400, { error: 'user_count is only available for presence channels.' });
        return;
    }
    const out: Record<string, unknown> = { occupied: channel !== undefined && channel.sockets.size > 0 };
    if (info.has('subscription_count')) {
        out.subscription_count = channel?.sockets.size ?? 0;
    }
    if (info.has('user_count')) {
        out.user_count = channel?.users.size ?? 0;
    }
    reply(res, 200, out);
}
