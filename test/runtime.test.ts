/**
 * The programmatic API: apps at runtime, graceful stop, TLS, the CLI.
 */
import { request } from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs } from '../src/cli-main.js';
import { createSelfSignedCert } from '../src/cert.js';
import { ConfigError } from '../src/config.js';
import { signedApiQuery } from '../src/protocol.js';
import { type SocketsServer, start } from '../src/server.js';
import { startTestServer } from '../src/test-server.js';
import { raw, sign, sleep, until } from './helpers.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const s of stops.splice(0)) {
        await s();
    }
});

async function srv(apps = [{ id: 'a', key: 'key-a', secret: 'secret-aaaa' }]): Promise<SocketsServer> {
    const s = await start({ port: 0, apps });
    stops.push(() => s.stop({ timeoutMs: 500 }));
    return s;
}

async function signedGet(s: SocketsServer, app: { id: string; key: string; secret: string }, path: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams(signedApiQuery(app.key, app.secret, 'GET', path, undefined, extra));
    const res = await fetch(`${s.url}${path}?${q}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('apps at runtime', () => {
    it('adds an app with no restart and serves it at once', async () => {
        const s = await srv();
        const before = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        s.addApp({ id: 'b', key: 'key-b', secret: 'secret-bbbb' });
        const b = await raw(`${s.wsUrl}/app/key-b?protocol=7`);
        expect(b.socketId()).toMatch(/^\d+\.\d+$/);
        expect(before.ws.readyState).toBe(1);
        expect(s.apps().map((a) => a.id)).toEqual(['a', 'b']);
    });

    it('refuses a duplicate id or key, and bad config, naming the field and never the secret', async () => {
        const s = await srv();
        expect(() => s.addApp({ id: 'a', key: 'k2', secret: 'secret-2222' })).toThrow(ConfigError);
        expect(() => s.addApp({ id: 'c', key: 'key-a', secret: 'secret-2222' })).toThrow(/key/);
        expect(() => s.addApp({ id: 'd', key: 'kd', secret: 'short' })).toThrow(/secret/);
        expect(() => s.addApp({ id: 'e', key: 'ke', secret: 'sekrit-value', limits: { maxConnections: 0 } })).toThrow(/maxConnections/);
        expect(() => s.addApp({ id: 'f', key: 'kf', secret: 'sekrit-value', limits: { nope: 1 } as never })).toThrow(/nope/);
        try {
            s.addApp({ id: 'g', key: 'bad key', secret: 'sekrit-value' });
        } catch (e) {
            expect((e as Error).message).not.toContain('sekrit-value');
        }
    });

    it('turns client events on and off live, without dropping sockets', async () => {
        const s = await srv();
        const sub = async (user: string) => {
            const r = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
            const data = JSON.stringify({ user_id: user });
            r.send({ event: 'pusher:subscribe', data: { channel: 'presence-x', auth: sign('secret-aaaa', 'key-a', r.socketId(), 'presence-x', data), channel_data: data } });
            await r.next('pusher_internal:subscription_succeeded');
            return r;
        };
        const a = await sub('a');
        const b = await sub('b');
        a.send({ event: 'client-x', channel: 'presence-x', data: 1 });
        await a.next('pusher:error');
        s.updateApp('a', { clientEvents: true });
        a.send({ event: 'client-x', channel: 'presence-x', data: 2 });
        expect((await b.next('client-x')).data).toBe(2);
        s.updateApp('a', { clientEvents: false });
        a.send({ event: 'client-x', channel: 'presence-x', data: 3 });
        await a.next('pusher:error');
        expect(a.ws.readyState).toBe(1);
    });

    it('applies new limits to live sockets', async () => {
        const s = await srv();
        const r = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        s.updateApp('a', { limits: { maxChannelsPerSocket: 1 } });
        r.send({ event: 'pusher:subscribe', data: { channel: 'one' } });
        r.send({ event: 'pusher:subscribe', data: { channel: 'two' } });
        await r.next('pusher_internal:subscription_succeeded');
        await r.next('pusher:subscription_error');
    });

    it('closes an app\'s sockets 4200 when its secret changes, and only that app\'s', async () => {
        const s = await srv([
            { id: 'a', key: 'key-a', secret: 'secret-aaaa' },
            { id: 'b', key: 'key-b', secret: 'secret-bbbb' },
        ]);
        const a = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        const b = await raw(`${s.wsUrl}/app/key-b?protocol=7`);
        s.updateApp('a', { secret: 'secret-new-a' });
        expect((await a.closed).code).toBe(4200);
        await sleep(50);
        expect(b.ws.readyState).toBe(1);
    });

    it('closes 4003 when an app is disabled, and refuses new sockets and API calls', async () => {
        const s = await srv();
        const a = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        s.updateApp('a', { enabled: false });
        expect((await a.closed).code).toBe(4003);
        expect((await (await raw(`${s.wsUrl}/app/key-a?protocol=7`)).closed).code).toBe(4003);
        expect((await signedGet(s, { id: 'a', key: 'key-a', secret: 'secret-aaaa' }, '/apps/a/channels')).status).toBe(403);
    });

    it('moves the key: the old one stops connecting, the new one works', async () => {
        const s = await srv();
        s.updateApp('a', { key: 'key-a2' });
        expect((await (await raw(`${s.wsUrl}/app/key-a?protocol=7`)).closed).code).toBe(4001);
        expect((await raw(`${s.wsUrl}/app/key-a2?protocol=7`)).socketId()).not.toBe('');
    });

    it('never exposes the secret through getApp or apps', async () => {
        const s = await srv();
        expect(JSON.stringify(s.apps())).not.toContain('secret-aaaa');
        expect(JSON.stringify(s.getApp('a'))).not.toContain('secret-aaaa');
    });
});

describe('channel queries', () => {
    it('lists occupied channels, presence user counts, and users', async () => {
        const s = await srv();
        const app = { id: 'a', key: 'key-a', secret: 'secret-aaaa' };
        const r = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        r.send({ event: 'pusher:subscribe', data: { channel: 'orders' } });
        const data = JSON.stringify({ user_id: 'u1' });
        r.send({ event: 'pusher:subscribe', data: { channel: 'presence-room', auth: sign('secret-aaaa', 'key-a', r.socketId(), 'presence-room', data), channel_data: data } });
        await r.next('pusher_internal:subscription_succeeded');
        await r.next('pusher_internal:subscription_succeeded');

        expect((await signedGet(s, app, '/apps/a/channels')).body).toEqual({ channels: { orders: {}, 'presence-room': {} } });
        expect((await signedGet(s, app, '/apps/a/channels', { filter_by_prefix: 'presence-', info: 'user_count' })).body).toEqual({ channels: { 'presence-room': { user_count: 1 } } });
        expect((await signedGet(s, app, '/apps/a/channels', { info: 'user_count' })).status).toBe(400);
        expect((await signedGet(s, app, '/apps/a/channels/orders', { info: 'subscription_count' })).body).toEqual({ occupied: true, subscription_count: 1 });
        expect((await signedGet(s, app, '/apps/a/channels/empty')).body).toEqual({ occupied: false });
        expect((await signedGet(s, app, '/apps/a/channels/presence-room/users')).body).toEqual({ users: [{ id: 'u1' }] });
        expect((await signedGet(s, app, '/apps/a/channels/orders/users')).status).toBe(400);
    });

    it('publishes a batch all-or-nothing', async () => {
        const s = await srv();
        const r = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        r.send({ event: 'pusher:subscribe', data: { channel: 'c' } });
        await r.next('pusher_internal:subscription_succeeded');
        const post = async (body: string) => {
            const q = new URLSearchParams(signedApiQuery('key-a', 'secret-aaaa', 'POST', '/apps/a/batch_events', body));
            return fetch(`${s.url}/apps/a/batch_events?${q}`, { method: 'POST', body });
        };
        const bad = await post(JSON.stringify({ batch: [{ channel: 'c', name: 'one', data: '1' }, { channel: 'c', name: 'two', data: 2 }] }));
        expect(bad.status).toBe(400);
        await sleep(50);
        expect(r.frames.some((f) => f.event === 'one')).toBe(false);
        const ok = await post(JSON.stringify({ batch: [{ channel: 'c', name: 'one', data: '1' }, { channel: 'c', name: 'two', data: '2' }] }));
        expect(ok.status).toBe(200);
        await r.next('one');
        await r.next('two');
    });
});

describe('graceful stop', () => {
    it('closes every socket 4200, refuses new ones, and resolves', async () => {
        const s = await start({ port: 0, apps: [{ id: 'a', key: 'key-a', secret: 'secret-aaaa' }] });
        const a = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        const b = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        const started = Date.now();
        await s.stop({ timeoutMs: 2000 });
        expect((await a.closed).code).toBe(4200);
        expect((await b.closed).code).toBe(4200);
        expect(Date.now() - started).toBeLessThan(1500);
        await expect(raw(`${s.wsUrl}/app/key-a?protocol=7`)).rejects.toThrow();
    });
});

describe('TLS', () => {
    it('builds a certificate Node parses and that covers localhost and 127.0.0.1', () => {
        const { cert } = createSelfSignedCert();
        const x = new X509Certificate(cert);
        expect(x.checkHost('localhost')).toBe('localhost');
        expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1');
        expect(x.verify(x.publicKey)).toBe(true);
        expect(x.ca).toBe(false);
    });

    it('serves wss and https with a self-signed certificate a client verifies', async () => {
        const t = await startTestServer({ tls: true });
        stops.push(() => t.stop());
        expect(t.wsUrl.startsWith('wss://')).toBe(true);
        const r = await raw(`${t.wsUrl}/app/${t.app.key}?protocol=7`, {}, t.ca);
        expect(r.socketId()).toMatch(/^\d+\.\d+$/);
        // Without trusting the certificate, the client refuses it.
        await expect(raw(`${t.wsUrl}/app/${t.app.key}?protocol=7`)).rejects.toThrow();
        const status = await new Promise<number>((resolve, reject) => {
            request(`${t.url}/up`, { ca: t.ca }, (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            })
                .on('error', reject)
                .end();
        });
        expect(status).toBe(200);
    });
});

describe('CLI', () => {
    const io = () => {
        const out: string[] = [];
        const err: string[] = [];
        return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
    };

    it('parses apps and refuses bad arguments', () => {
        expect(parseArgs(['--app', 'a:k:s3cret-1', '--app', 'b:k2:s3cret-2:client-events', '--port', '0']).apps).toEqual([
            { id: 'a', key: 'k', secret: 's3cret-1', clientEvents: false },
            { id: 'b', key: 'k2', secret: 's3cret-2', clientEvents: true },
        ]);
        expect(() => parseArgs(['--app', 'a:k'])).toThrow();
        expect(() => parseArgs(['--app', 'a:k:s:other'])).toThrow();
        expect(() => parseArgs(['--port', 'x'])).toThrow();
        expect(() => parseArgs(['--tls-cert', 'c.pem'])).toThrow();
        expect(() => parseArgs(['--watch'])).toThrow();
        expect(() => parseArgs(['--bogus'])).toThrow();
    });

    it('starts on an ephemeral port and prints the ready line first', async () => {
        const o = io();
        const s = await main(['--app', 'a:key-a:secret-aaaa', '--port', '0'], o.io);
        stops.push(() => s!.stop({ timeoutMs: 500 }));
        const ready = JSON.parse(o.out[0]!) as { ready: boolean; port: number; wsUrl: string };
        expect(ready.ready).toBe(true);
        expect(ready.port).toBeGreaterThan(0);
        expect((await raw(`${ready.wsUrl}/app/key-a?protocol=7`)).socketId()).not.toBe('');
    });

    it('with --watch, adds, updates and removes apps from the config file live', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'fancy-sockets-'));
        const file = join(dir, 'apps.json');
        writeFileSync(file, JSON.stringify({ apps: [{ id: 'a', key: 'key-a', secret: 'secret-aaaa' }] }));
        const o = io();
        const s = (await main(['--config', file, '--watch', '--port', '0'], o.io))!;
        stops.push(async () => {
            await s.stop({ timeoutMs: 500 });
            rmSync(dir, { recursive: true, force: true });
        });
        const a = await raw(`${s.wsUrl}/app/key-a?protocol=7`);
        writeFileSync(file, JSON.stringify({ apps: [{ id: 'b', key: 'key-b', secret: 'secret-bbbb', clientEvents: true }] }));
        await until(() => s.getApp('b') !== undefined, 5000, 'app b');
        expect(s.getApp('b')!.clientEvents).toBe(true);
        expect(s.getApp('a')).toBeUndefined();
        expect((await a.closed).code).toBe(4001);
    });
});
