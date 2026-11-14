import { createHmac } from 'node:crypto';
import Pusher from 'pusher-js';
import { WebSocket } from 'ws';
import type { TestServer } from '../src/test-server.js';

/**
 * An INDEPENDENT channel signer: plain node:crypto, not src/protocol.ts, so a
 * test that subscribes is not checking the server against itself.
 */
export function sign(secret: string, key: string, socketId: string, channel: string, channelData?: string): string {
    const subject = channelData === undefined ? `${socketId}:${channel}` : `${socketId}:${channel}:${channelData}`;
    return `${key}:${createHmac('sha256', secret).update(subject).digest('hex')}`;
}

export interface ClientOptions {
    /** Presence identity for this client. */
    user?: { id: string | number; info?: unknown };
    /** Sign with this secret instead of the app's (forgery tests). */
    secret?: string;
    key?: string;
}

/** A real pusher-js client against the test server, authorising with the app's secret. */
export function pusherClient(t: Pick<TestServer, 'port' | 'app'>, opts: ClientOptions = {}): Pusher {
    const secret = opts.secret ?? t.app.secret;
    const key = opts.key ?? t.app.key;
    return new Pusher(key, {
        cluster: 'mt1',
        wsHost: '127.0.0.1',
        wsPort: t.port,
        wssPort: t.port,
        forceTLS: false,
        enabledTransports: ['ws'],
        disableStats: true,
        channelAuthorization: {
            transport: 'ajax',
            endpoint: '/unused',
            customHandler: ({ socketId, channelName }, callback) => {
                if (channelName.startsWith('presence-')) {
                    const channelData = JSON.stringify({ user_id: opts.user?.id ?? 'anon', user_info: opts.user?.info ?? {} });
                    callback(null, { auth: sign(secret, t.app.key, socketId, channelName, channelData), channel_data: channelData });
                } else {
                    callback(null, { auth: sign(secret, t.app.key, socketId, channelName) });
                }
            },
        },
    });
}

export function connected(p: Pusher): Promise<string> {
    return new Promise((resolve, reject) => {
        if (p.connection.state === 'connected') {
            resolve(p.connection.socket_id);
            return;
        }
        p.connection.bind('connected', () => resolve(p.connection.socket_id));
        p.connection.bind('failed', () => reject(new Error('pusher-js failed to connect')));
    });
}

export function subscribed(p: Pusher, name: string): Promise<ReturnType<Pusher['subscribe']>> {
    return new Promise((resolve, reject) => {
        const channel = p.subscribe(name);
        channel.bind('pusher:subscription_succeeded', () => resolve(channel));
        channel.bind('pusher:subscription_error', (e: unknown) => reject(Object.assign(new Error('subscription_error'), { detail: e })));
    });
}

export function subscriptionError(p: Pusher, name: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const channel = p.subscribe(name);
        channel.bind('pusher:subscription_succeeded', () => reject(new Error('subscribed, expected an error')));
        channel.bind('pusher:subscription_error', (e: unknown) => resolve(e));
    });
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export async function until(check: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error(`timed out waiting for ${what}`);
        }
        await sleep(10);
    }
}

/** A raw protocol client: every frame it receives, and its close code. */
export interface Raw {
    ws: WebSocket;
    frames: Array<Record<string, unknown>>;
    closed: Promise<{ code: number; reason: string }>;
    socketId: () => string;
    send(message: unknown): void;
    next(event: string, ms?: number): Promise<Record<string, unknown>>;
}

export async function raw(url: string, headers: Record<string, string> = {}, ca?: string): Promise<Raw> {
    const ws = new WebSocket(url, { headers, ...(ca ? { ca } : {}) });
    const frames: Array<Record<string, unknown>> = [];
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
    });
    ws.on('error', () => {});
    ws.on('message', (data: Buffer) => {
        try {
            frames.push(JSON.parse(data.toString()));
        } catch {
            frames.push({ unparsed: data.toString() });
        }
    });
    await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (e: Error) => reject(e));
        ws.on('unexpected-response', (...args: unknown[]) => reject(new Error(`HTTP ${(args[1] as { statusCode: number }).statusCode}`)));
    });
    const r: Raw = {
        ws,
        frames,
        closed,
        socketId: () => {
            const est = frames.find((f) => f.event === 'pusher:connection_established');
            return est ? (JSON.parse(est.data as string) as { socket_id: string }).socket_id : '';
        },
        send: (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message)),
        next: async (event, ms = 3000) => {
            let seen = 0;
            const end = Date.now() + ms;
            for (;;) {
                const found = frames.slice(seen).find((f) => f.event === event);
                if (found) {
                    frames.splice(frames.indexOf(found), 1);
                    return found;
                }
                seen = 0;
                if (Date.now() > end) {
                    throw new Error(`no ${event} within ${ms} ms; got ${frames.map((f) => f.event).join(', ')}`);
                }
                await sleep(5);
            }
        },
    };
    // Either the connection is established, or it is refused in-protocol
    // (pusher:error then a close); both are a usable Raw.
    let state: 'open' | 'closed' = 'open';
    void closed.then(() => {
        state = 'closed';
    });
    await until(() => state === 'closed' || frames.some((f) => f.event === 'pusher:connection_established' || f.event === 'pusher:error'), 3000, 'the first frame');
    return r;
}

export function rawUrl(t: Pick<TestServer, 'wsUrl' | 'app'>, key = t.app.key): string {
    return `${t.wsUrl}/app/${key}?protocol=7&client=test&version=1`;
}
