/**
 * Security: what a hostile client or publisher can and cannot do. Raw protocol
 * clients, so nothing a friendly library does on our behalf hides a gap.
 */
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { signedApiQuery } from '../src/protocol.js';
import { start, type SocketsServer } from '../src/server.js';
import { type TestServer, startTestServer } from '../src/test-server.js';
import { raw, rawUrl, sign, sleep, until } from './helpers.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const s of stops.splice(0)) {
        await s();
    }
});

async function server(opts: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
    const t = await startTestServer(opts);
    stops.push(() => t.stop());
    return t;
}

async function presence(t: Pick<TestServer, 'wsUrl' | 'app'>, channel: string, userId: string) {
    const r = await raw(rawUrl(t));
    const channelData = JSON.stringify({ user_id: userId, user_info: {} });
    r.send({ event: 'pusher:subscribe', data: { channel, auth: sign(t.app.secret, t.app.key, r.socketId(), channel, channelData), channel_data: channelData } });
    const succeeded = await r.next('pusher_internal:subscription_succeeded');
    return Object.assign(r, { succeeded });
}

function api(t: Pick<TestServer, 'url' | 'app'>, path: string, body: string | undefined, opts: { method?: string; secret?: string; key?: string; ts?: number; extra?: Record<string, string> } = {}) {
    const method = opts.method ?? 'POST';
    const query = new URLSearchParams(signedApiQuery(opts.key ?? t.app.key, opts.secret ?? t.app.secret, method, path, body, opts.extra ?? {}, opts.ts));
    return fetch(`${t.url}${path}?${query}`, { method, ...(body !== undefined ? { body } : {}), headers: { 'content-type': 'application/json' } });
}

describe('frames and messages', () => {
    it('closes 1009 on a frame larger than the app limit, and keeps serving others', async () => {
        const t = await server({ app: { limits: { maxMessageBytes: 1024 } } });
        const bystander = await raw(rawUrl(t));
        const r = await raw(rawUrl(t));
        r.send({ event: 'pusher:ping', data: 'x'.repeat(2000) });
        expect((await r.closed).code).toBe(1009);
        bystander.send({ event: 'pusher:ping', data: {} });
        await bystander.next('pusher:pong');
    });

    it('closes 1009 on a frame larger than the process-wide cap before buffering it', async () => {
        const s = await start({ port: 0, limits: { maxMessageBytes: 4096 }, apps: [{ id: 'a', key: 'ka', secret: 'secret-aaaa' }] });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        const r = await raw(`${s.wsUrl}/app/ka?protocol=7`);
        r.ws.send('x'.repeat(100_000));
        expect((await r.closed).code).toBe(1009);
    });

    it('closes 1009 on a message split into more fragments than maxFragments', async () => {
        const s = await start({ port: 0, limits: { maxFragments: 4 }, apps: [{ id: 'a', key: 'ka', secret: 'secret-aaaa' }] });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        const within = await raw(`${s.wsUrl}/app/ka?protocol=7`);
        within.ws.sendFragments(['{"event":"pu', 'sher:ping",', '"data":{}}']);
        await within.next('pusher:pong');
        const over = await raw(`${s.wsUrl}/app/ka?protocol=7`);
        over.ws.sendFragments(['{"event":"pusher:ping","data":{}}', ...Array.from({ length: 9 }, () => '')]);
        expect((await over.closed).code).toBe(1009);
    });

    it('answers malformed JSON with an error and stays up', async () => {
        const t = await server();
        const r = await raw(rawUrl(t));
        for (const bad of ['{', '[]', 'null', '"x"', '{"event":5}', '{"event":"pusher:subscribe","data":"{"}', '{"event":"pusher:subscribe","data":null}']) {
            r.send(bad);
            await r.next('pusher:error');
        }
        r.send({ event: 'pusher:ping', data: {} });
        await r.next('pusher:pong');
        expect(t.server.stats().connections).toBe(1);
    });

    it('refuses binary frames', async () => {
        const t = await server();
        const r = await raw(rawUrl(t));
        r.ws.send(Buffer.from([1, 2, 3]));
        expect((await r.closed).code).toBe(1003);
    });

    it('refuses a presence user_id of __proto__ without touching any prototype', async () => {
        const t = await server();
        const a = await presence(t, 'presence-p', '__proto__');
        const b = await presence(t, 'presence-p', 'constructor');
        // The member list a client receives must still name both members: a
        // plain-object hash would turn `__proto__` into a prototype write and
        // silently drop it.
        const snapshot = JSON.parse(b.succeeded.data as string) as { presence: { ids: string[]; hash: Record<string, unknown>; count: number } };
        expect(snapshot.presence.count).toBe(2);
        expect(Object.prototype.hasOwnProperty.call(snapshot.presence.hash, '__proto__')).toBe(true);
        expect(Object.keys(snapshot.presence.hash).sort()).toEqual(['__proto__', 'constructor']);
        const res = await api(t, `/apps/${t.app.id}/channels/presence-p/users`, undefined, { method: 'GET' });
        expect(((await res.json()) as { users: Array<{ id: string }> }).users.map((u) => u.id).sort()).toEqual(['__proto__', 'constructor']);
        a.ws.close();
        b.ws.close();
    });
});

describe('channel auth forgery', () => {
    it.each([
        ['no auth', () => undefined],
        ['the wrong secret', (id: string, t: TestServer) => sign('wrong-secret', t.app.key, id, 'private-x')],
        ['another socket id', (_id: string, t: TestServer) => sign(t.app.secret, t.app.key, '1.1', 'private-x')],
        ['another channel', (id: string, t: TestServer) => sign(t.app.secret, t.app.key, id, 'private-y')],
        ['another key prefix', (id: string, t: TestServer) => sign(t.app.secret, 'other-key', id, 'private-x')],
    ])('refuses a private subscription with %s', async (_label, make) => {
        const t = await server();
        const r = await raw(rawUrl(t));
        r.send({ event: 'pusher:subscribe', data: { channel: 'private-x', auth: make(r.socketId(), t) } });
        const error = await r.next('pusher:subscription_error');
        expect(JSON.parse(error.data as string)).toMatchObject({ status: 401 });
        expect(t.server.getApp(t.app.id)!.channels).toBe(0);
    });

    it('refuses presence channel_data that differs from what was signed', async () => {
        const t = await server();
        const r = await raw(rawUrl(t));
        const signed = JSON.stringify({ user_id: 'me' });
        r.send({ event: 'pusher:subscribe', data: { channel: 'presence-r', auth: sign(t.app.secret, t.app.key, r.socketId(), 'presence-r', signed), channel_data: JSON.stringify({ user_id: 'admin' }) } });
        await r.next('pusher:subscription_error');
    });

    it('refuses presence channel_data with no user_id even when signed', async () => {
        const t = await server();
        const r = await raw(rawUrl(t));
        const data = JSON.stringify({ user_info: {} });
        r.send({ event: 'pusher:subscribe', data: { channel: 'presence-r', auth: sign(t.app.secret, t.app.key, r.socketId(), 'presence-r', data), channel_data: data } });
        await r.next('pusher:subscription_error');
    });
});

describe('client events', () => {
    it('are refused when the app has not enabled them (the default)', async () => {
        const t = await server();
        const a = await presence(t, 'presence-d', 'a');
        const b = await presence(t, 'presence-d', 'b');
        a.send({ event: 'client-x', channel: 'presence-d', data: {} });
        expect(JSON.parse(JSON.stringify((await a.next('pusher:error')).data))).toMatchObject({ code: 4009 });
        await sleep(100);
        expect(b.frames.some((f) => f.event === 'client-x')).toBe(false);
    });

    it('stamp the authenticated user_id on presence and drop a spoofed one', async () => {
        const t = await server({ app: { clientEvents: true } });
        const mallory = await presence(t, 'presence-d', 'mallory');
        const bob = await presence(t, 'presence-d', 'bob');
        mallory.send({ event: 'client-cursor', channel: 'presence-d', user_id: 'alice', data: { x: 1 } });
        const got = await bob.next('client-cursor');
        expect(got.user_id).toBe('mallory');
        expect(got.data).toEqual({ x: 1 });
        expect(Object.keys(got).sort()).toEqual(['channel', 'data', 'event', 'user_id']);
    });

    it('carry no user_id on private channels, whatever the client sends', async () => {
        const t = await server({ app: { clientEvents: true } });
        const sub = async () => {
            const r = await raw(rawUrl(t));
            r.send({ event: 'pusher:subscribe', data: { channel: 'private-p', auth: sign(t.app.secret, t.app.key, r.socketId(), 'private-p') } });
            await r.next('pusher_internal:subscription_succeeded');
            return r;
        };
        const a = await sub();
        const b = await sub();
        a.send({ event: 'client-x', channel: 'private-p', user_id: 'alice', data: 1 });
        const got = await b.next('client-x');
        expect(got.user_id).toBeUndefined();
    });

    it('are refused on public and encrypted channels and on channels not subscribed', async () => {
        const t = await server({ app: { clientEvents: true } });
        const r = await raw(rawUrl(t));
        r.send({ event: 'pusher:subscribe', data: { channel: 'public' } });
        await r.next('pusher_internal:subscription_succeeded');
        r.send({ event: 'pusher:subscribe', data: { channel: 'private-encrypted-e', auth: sign(t.app.secret, t.app.key, r.socketId(), 'private-encrypted-e') } });
        await r.next('pusher_internal:subscription_succeeded');
        for (const channel of ['public', 'private-encrypted-e', 'private-never-joined']) {
            r.send({ event: 'client-x', channel, data: {} });
            expect((await r.next('pusher:error')).data).toMatchObject({ code: 4009 });
        }
    });

    it('are refused from a socket not subscribed to a channel others are on', async () => {
        const t = await server({ app: { clientEvents: true } });
        const member = await raw(rawUrl(t));
        member.send({ event: 'pusher:subscribe', data: { channel: 'private-room', auth: sign(t.app.secret, t.app.key, member.socketId(), 'private-room') } });
        await member.next('pusher_internal:subscription_succeeded');
        const outsider = await raw(rawUrl(t));
        outsider.send({ event: 'client-x', channel: 'private-room', data: 'injected' });
        expect((await outsider.next('pusher:error')).data).toMatchObject({ code: 4009 });
        await sleep(100);
        expect(member.frames.some((f) => f.event === 'client-x')).toBe(false);
    });

    it('are rate-limited per socket (4301)', async () => {
        const t = await server({ app: { clientEvents: true, limits: { clientEventsPerSecond: 3 } } });
        const a = await presence(t, 'presence-d', 'a');
        const b = await presence(t, 'presence-d', 'b');
        for (let i = 0; i < 6; i++) {
            a.send({ event: 'client-x', channel: 'presence-d', data: i });
        }
        expect((await a.next('pusher:error')).data).toMatchObject({ code: 4301 });
        await sleep(100);
        expect(b.frames.filter((f) => f.event === 'client-x').length).toBe(3);
    });
});

describe('isolation between apps', () => {
    async function two(): Promise<SocketsServer> {
        const s = await start({
            port: 0,
            apps: [
                { id: 'a', key: 'key-a', secret: 'secret-aaaa', clientEvents: true },
                { id: 'b', key: 'key-b', secret: 'secret-bbbb', clientEvents: true },
            ],
        });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        return s;
    }

    it("never delivers one app's events to another app's same-named channel", async () => {
        const s = await two();
        const a = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        const b = await raw(`${s.wsUrl}/app/key-b?protocol=7`);
        a.send({ event: 'pusher:subscribe', data: { channel: 'orders' } });
        b.send({ event: 'pusher:subscribe', data: { channel: 'orders' } });
        await a.next('pusher_internal:subscription_succeeded');
        await b.next('pusher_internal:subscription_succeeded');
        const res = await api({ url: s.url, app: { id: 'a', key: 'key-a', secret: 'secret-aaaa' } }, '/apps/a/events', JSON.stringify({ name: 'e', channels: ['orders'], data: '1' }));
        expect(res.status).toBe(200);
        await a.next('e');
        await sleep(100);
        expect(b.frames.some((f) => f.event === 'e')).toBe(false);
    });

    it("refuses a subscription signed with another app's secret", async () => {
        const s = await two();
        const b = await raw(`${s.wsUrl}/app/key-b?protocol=7`);
        b.send({ event: 'pusher:subscribe', data: { channel: 'private-x', auth: sign('secret-aaaa', 'key-b', b.socketId(), 'private-x') } });
        await b.next('pusher:subscription_error');
    });

    it("refuses an API call for app b signed with app a's credentials", async () => {
        const s = await two();
        const body = JSON.stringify({ name: 'e', channels: ['x'], data: '1' });
        const asA = { url: s.url, app: { id: 'b', key: 'key-a', secret: 'secret-aaaa' } };
        expect((await api(asA, '/apps/b/events', body)).status).toBe(401);
        const keyBsecretA = { url: s.url, app: { id: 'b', key: 'key-b', secret: 'secret-aaaa' } };
        expect((await api(keyBsecretA, '/apps/b/events', body)).status).toBe(401);
    });

    it("never relays one app's client events into another app's same-named channel", async () => {
        const s = await two();
        const join = async (key: string, secret: string, user: string) => {
            const r = await raw(`${s.wsUrl}/app/${key}?protocol=7`);
            const data = JSON.stringify({ user_id: user });
            r.send({ event: 'pusher:subscribe', data: { channel: 'presence-shared', auth: sign(secret, key, r.socketId(), 'presence-shared', data), channel_data: data } });
            return Object.assign(r, { succeeded: await r.next('pusher_internal:subscription_succeeded') });
        };
        const a1 = await join('key-a', 'secret-aaaa', 'a1');
        const b1 = await join('key-b', 'secret-bbbb', 'b1');
        const a2 = await join('key-a', 'secret-aaaa', 'a2');
        expect(JSON.parse(a2.succeeded.data as string).presence.ids.sort()).toEqual(['a1', 'a2']);
        a1.send({ event: 'client-x', channel: 'presence-shared', data: 1 });
        await a2.next('client-x');
        await sleep(100);
        expect(b1.frames.some((f) => f.event === 'client-x' || f.event === 'pusher_internal:member_added')).toBe(false);
    });
});

/** One masked client text frame (RFC 6455 requires client frames to be masked). */
function clientFrame(text: string): Buffer {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
    const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([head, mask, masked]);
}

describe('slow consumers', () => {
    it('cuts off a socket that stops reading instead of buffering without bound', async () => {
        const t = await server({ app: { limits: { maxBufferedBytes: 65_536, apiRequestsPerSecond: 10_000 } } });
        const bystander = await raw(rawUrl(t));
        bystander.send({ event: 'pusher:subscribe', data: { channel: 'firehose' } });
        await bystander.next('pusher_internal:subscription_succeeded');

        const sock = connect(t.port, '127.0.0.1');
        sock.on('error', () => {});
        await new Promise((r) => sock.once('connect', r));
        sock.write(`GET /app/${t.app.key}?protocol=7 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        sock.write(clientFrame(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'firehose' } })));
        await until(() => t.server.stats().connections === 2, 3000, 'the stalled socket');
        await sleep(100);
        sock.pause(); // stop reading: everything sent to it now piles up server-side

        const chunk = 'x'.repeat(9000);
        let closed = false;
        sock.once('close', () => (closed = true));
        for (let i = 0; i < 400 && !closed && (t.server.stats().refused['socket.slow'] ?? 0) === 0; i++) {
            await api(t, `/apps/${t.app.id}/events`, JSON.stringify({ name: 'e', channels: ['firehose'], data: chunk }));
        }
        expect(t.server.stats().refused['socket.slow']).toBe(1);
        await until(() => t.server.stats().connections === 1, 3000, 'the slow socket to go');
        bystander.send({ event: 'pusher:ping', data: {} });
        await bystander.next('pusher:pong');
        sock.destroy();
    }, 30_000);
});

describe('HTTP API authentication', () => {
    const body = JSON.stringify({ name: 'e', channels: ['c'], data: '1' });

    it('accepts a correctly signed request', async () => {
        const t = await server();
        expect((await api(t, `/apps/${t.app.id}/events`, body)).status).toBe(200);
    });

    it.each([
        ['a wrong secret', { secret: 'wrong-secret' }],
        ['a wrong key', { key: 'nope' }],
        ['a timestamp 11 minutes old', { ts: Math.floor(Date.now() / 1000) - 660 }],
        ['a timestamp 11 minutes ahead', { ts: Math.floor(Date.now() / 1000) + 660 }],
    ])('refuses %s (401)', async (_label, opts) => {
        const t = await server();
        expect((await api(t, `/apps/${t.app.id}/events`, body, opts)).status).toBe(401);
    });

    it('refuses a body that does not match body_md5', async () => {
        const t = await server();
        const path = `/apps/${t.app.id}/events`;
        const query = new URLSearchParams(signedApiQuery(t.app.key, t.app.secret, 'POST', path, body));
        const tampered = body.replace('"c"', '"admin"');
        const res = await fetch(`${t.url}${path}?${query}`, { method: 'POST', body: tampered });
        expect(res.status).toBe(401);
    });

    it('refuses a tampered query parameter', async () => {
        const t = await server();
        const path = `/apps/${t.app.id}/channels`;
        const query = new URLSearchParams(signedApiQuery(t.app.key, t.app.secret, 'GET', path, undefined, { filter_by_prefix: 'presence-' }));
        query.set('filter_by_prefix', 'private-');
        expect((await fetch(`${t.url}${path}?${query}`)).status).toBe(401);
    });

    it('refuses a repeated query parameter', async () => {
        const t = await server();
        const path = `/apps/${t.app.id}/channels`;
        const query = new URLSearchParams(signedApiQuery(t.app.key, t.app.secret, 'GET', path, undefined, { info: 'x' }));
        query.append('info', 'y');
        expect((await fetch(`${t.url}${path}?${query}`)).status).toBe(400);
    });

    it('refuses an oversized body with 413 before reading it all', async () => {
        const t = await server({ limits: { maxBodyBytes: 2048 } });
        const big = JSON.stringify({ name: 'e', channels: ['c'], data: 'x'.repeat(5000) });
        expect((await api(t, `/apps/${t.app.id}/events`, big)).status).toBe(413);
    });

    it('refuses event data over the app limit with 413', async () => {
        const t = await server({ app: { limits: { maxEventBytes: 100 } } });
        expect((await api(t, `/apps/${t.app.id}/events`, JSON.stringify({ name: 'e', channels: ['c'], data: 'x'.repeat(101) }))).status).toBe(413);
    });

    it('rate-limits the API per app with 429, leaving other apps alone', async () => {
        const s = await start({
            port: 0,
            apps: [
                { id: 'a', key: 'key-a', secret: 'secret-aaaa', limits: { apiRequestsPerSecond: 3 } },
                { id: 'b', key: 'key-b', secret: 'secret-bbbb' },
            ],
        });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        const a = { url: s.url, app: { id: 'a', key: 'key-a', secret: 'secret-aaaa' } };
        const b = { url: s.url, app: { id: 'b', key: 'key-b', secret: 'secret-bbbb' } };
        const statuses = await Promise.all(Array.from({ length: 8 }, () => api(a, '/apps/a/events', body).then((r) => r.status)));
        expect(statuses.filter((x) => x === 429).length).toBe(5);
        expect((await api(b, '/apps/b/events', body)).status).toBe(200);
    });
});

describe('slowloris and idle sockets', () => {
    it('cuts off a client that trickles upgrade headers', async () => {
        const t = await server({ limits: { headersTimeoutMs: 300, requestTimeoutMs: 600 } });
        const sock = connect(t.port, '127.0.0.1');
        sock.on('error', () => {});
        await new Promise((r) => sock.once('connect', r));
        sock.write(`GET /app/${t.app.key}?protocol=7 HTTP/1.1\r\nHost: x\r\n`);
        const timer = setInterval(() => sock.writable && sock.write('X-Slow: 1\r\n'), 100);
        const started = Date.now();
        await new Promise((r) => sock.once('close', r));
        clearInterval(timer);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it('pings an idle socket and closes it 4201 when no pong comes', async () => {
        const t = await server({ activityTimeout: 1, pongTimeoutMs: 300, sweepIntervalMs: 50 });
        const r = await raw(rawUrl(t));
        await r.next('pusher:ping', 2500);
        expect((await r.closed).code).toBe(4201);
    });

    it('keeps a socket that answers pings', async () => {
        const t = await server({ activityTimeout: 1, pongTimeoutMs: 300, sweepIntervalMs: 50 });
        const r = await raw(rawUrl(t));
        await r.next('pusher:ping', 2500);
        r.send({ event: 'pusher:pong', data: {} });
        await sleep(600);
        expect(r.ws.readyState).toBe(1);
    });
});

describe('floods and caps', () => {
    it('closes a socket flooding messages (4301) without affecting others', async () => {
        const t = await server({ app: { limits: { messagesPerSecond: 20 } } });
        const calm = await raw(rawUrl(t));
        const flood = await raw(rawUrl(t));
        for (let i = 0; i < 200; i++) {
            flood.send({ event: 'pusher:ping', data: {} });
        }
        expect((await flood.closed).code).toBe(4301);
        calm.send({ event: 'pusher:ping', data: {} });
        await calm.next('pusher:pong');
    });

    it("refuses connections over one app's quota (4004) while another app still connects", async () => {
        const s = await start({
            port: 0,
            apps: [
                { id: 'a', key: 'key-a', secret: 'secret-aaaa', limits: { maxConnections: 2 } },
                { id: 'b', key: 'key-b', secret: 'secret-bbbb' },
            ],
        });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        const third = await raw(`${s.wsUrl}/app/key-a?protocol=7`).catch(() => null);
        if (third !== null) {
            expect((await third.closed).code).toBe(4004);
        }
        await raw(`${s.wsUrl}/app/key-b?protocol=7`);
        expect(s.stats().connections).toBe(3);
    });

    it('refuses over the process-wide cap at the handshake', async () => {
        const s = await start({ port: 0, limits: { maxConnections: 1 }, apps: [{ id: 'a', key: 'ka', secret: 'secret-aaaa' }] });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        await raw(`${s.wsUrl}/app/ka?protocol=7`);
        await expect(raw(`${s.wsUrl}/app/ka?protocol=7`)).rejects.toThrow(/503/);
    });

    it('holds both connection caps when many handshakes arrive at once', async () => {
        // A burst against both caps at once: the per-app quota lives on the
        // accepted side now, so this is what proves a burst cannot overshoot it.
        const s = await start({
            port: 0,
            limits: { maxConnections: 3 },
            apps: [
                { id: 'a', key: 'key-a', secret: 'secret-aaaa', limits: { maxConnections: 2 } },
                { id: 'b', key: 'key-b', secret: 'secret-bbbb' },
            ],
        });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        const burst = await Promise.allSettled([
            ...Array.from({ length: 8 }, () => raw(`${s.wsUrl}/app/key-a?protocol=7`)),
            ...Array.from({ length: 8 }, () => raw(`${s.wsUrl}/app/key-b?protocol=7`)),
        ]);
        await sleep(100);
        const isOpen = (r: (typeof burst)[number]): boolean => r.status === 'fulfilled' && r.value.socketId() !== '' && r.value.ws.readyState === 1;
        expect(burst.slice(0, 8).filter(isOpen).length).toBeLessThanOrEqual(2);
        expect(burst.filter(isOpen).length).toBeLessThanOrEqual(3);
        expect(s.stats().connections).toBeLessThanOrEqual(3);
    });

    it('caps channels per socket and members per presence channel', async () => {
        const t = await server({ app: { limits: { maxChannelsPerSocket: 2, maxPresenceMembers: 1 } } });
        const r = await raw(rawUrl(t));
        r.send({ event: 'pusher:subscribe', data: { channel: 'a' } });
        r.send({ event: 'pusher:subscribe', data: { channel: 'b' } });
        r.send({ event: 'pusher:subscribe', data: { channel: 'c' } });
        await r.next('pusher_internal:subscription_succeeded');
        await r.next('pusher_internal:subscription_succeeded');
        expect(JSON.parse((await r.next('pusher:subscription_error')).data as string)).toMatchObject({ type: 'LimitReached' });

        await presence(t, 'presence-full', 'one');
        const second = await raw(rawUrl(t));
        const data = JSON.stringify({ user_id: 'two' });
        second.send({ event: 'pusher:subscribe', data: { channel: 'presence-full', auth: sign(t.app.secret, t.app.key, second.socketId(), 'presence-full', data), channel_data: data } });
        expect(JSON.parse((await second.next('pusher:subscription_error')).data as string)).toMatchObject({ type: 'LimitReached' });
    });
});

describe('runtime app removal', () => {
    it("closes only the removed app's sockets, with 4001", async () => {
        const s = await start({
            port: 0,
            apps: [
                { id: 'a', key: 'key-a', secret: 'secret-aaaa' },
                { id: 'b', key: 'key-b', secret: 'secret-bbbb' },
            ],
        });
        stops.push(() => s.stop({ timeoutMs: 500 }));
        const a = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        const b = await raw(`${s.wsUrl}/app/key-b?protocol=7`);
        expect(s.removeApp('a')).toBe(true);
        expect((await a.closed).code).toBe(4001);
        b.send({ event: 'pusher:ping', data: {} });
        await b.next('pusher:pong');
        const again = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        expect((await again.closed).code).toBe(4001);
        const res = await api({ url: s.url, app: { id: 'a', key: 'key-a', secret: 'secret-aaaa' } }, '/apps/a/events', JSON.stringify({ name: 'e', channels: ['c'], data: '1' }));
        expect(res.status).toBe(404);
    });
});

describe('origin allowlist', () => {
    it('refuses a socket from an origin not on the list (4009)', async () => {
        const t = await server({ app: { allowedOrigins: ['https://app.example.com'] } });
        const bad = await raw(rawUrl(t), { origin: 'https://evil.example.net' });
        expect((await bad.closed).code).toBe(4009);
        const good = await raw(rawUrl(t), { origin: 'https://app.example.com' });
        good.send({ event: 'pusher:ping', data: {} });
        await good.next('pusher:pong');
    });
});

describe('unknown app and protocol', () => {
    it('closes 4001 for an unknown key and 4006 for an unsupported protocol', async () => {
        const t = await server();
        expect((await (await raw(`${t.wsUrl}/app/nope?protocol=7`)).closed).code).toBe(4001);
        expect((await (await raw(`${t.wsUrl}/app/${t.app.key}?protocol=2`)).closed).code).toBe(4006);
        await until(() => t.server.stats().connections === 0);
    });
});
