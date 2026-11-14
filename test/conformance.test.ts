/**
 * Protocol conformance, driven by REAL clients: pusher-js and Laravel Echo
 * (framework test dependencies under the carve-out). If these pass, the clients
 * Laravel apps actually ship work against this server.
 */
import Echo from 'laravel-echo';
import type Pusher from 'pusher-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signedApiQuery } from '../src/protocol.js';
import { type TestServer, startTestServer } from '../src/test-server.js';
import { connected, pusherClient, sleep, subscribed, subscriptionError, until } from './helpers.js';

let t: TestServer;
const clients: Pusher[] = [];

function client(opts: Parameters<typeof pusherClient>[1] = {}): Pusher {
    const p = pusherClient(t, opts);
    clients.push(p);
    return p;
}

async function publish(name: string, channels: string[], data: unknown, socketId?: string): Promise<Response> {
    const path = `/apps/${t.app.id}/events`;
    const body = JSON.stringify({ name, channels, data: JSON.stringify(data), ...(socketId ? { socket_id: socketId } : {}) });
    const query = new URLSearchParams(signedApiQuery(t.app.key, t.app.secret, 'POST', path, body));
    return fetch(`${t.url}${path}?${query}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
    t = await startTestServer({ app: { clientEvents: true } });
});

afterEach(async () => {
    for (const p of clients.splice(0)) {
        p.disconnect();
    }
    await t.stop();
});

describe('pusher-js', () => {
    it('connects and receives a socket id', async () => {
        const id = await connected(client());
        expect(id).toMatch(/^\d+\.\d+$/);
    });

    it('receives server events on a public channel', async () => {
        const p = client();
        const channel = await subscribed(p, 'orders');
        const got: unknown[] = [];
        channel.bind('order.shipped', (d: unknown) => got.push(d));
        expect((await publish('order.shipped', ['orders'], { id: 7 })).status).toBe(200);
        await until(() => got.length === 1);
        expect(got[0]).toEqual({ id: 7 });
    });

    it('excludes the socket_id named by the publisher', async () => {
        const a = client();
        const b = client();
        const ca = await subscribed(a, 'orders');
        const cb = await subscribed(b, 'orders');
        const gotA: unknown[] = [];
        const gotB: unknown[] = [];
        ca.bind('e', (d: unknown) => gotA.push(d));
        cb.bind('e', (d: unknown) => gotB.push(d));
        await publish('e', ['orders'], { n: 1 }, a.connection.socket_id);
        await until(() => gotB.length === 1);
        await sleep(100);
        expect(gotA).toEqual([]);
    });

    it('subscribes to a private channel with a valid signature', async () => {
        const p = client();
        const channel = await subscribed(p, 'private-account.1');
        const got: unknown[] = [];
        channel.bind('updated', (d: unknown) => got.push(d));
        await publish('updated', ['private-account.1'], { ok: true });
        await until(() => got.length === 1);
    });

    it('refuses a private channel signed with the wrong secret', async () => {
        const p = client({ secret: 'not-the-secret' });
        const error = (await subscriptionError(p, 'private-account.1')) as { type: string; status: number };
        expect(error.status).toBe(401);
    });

    it('tracks presence members across clients', async () => {
        const a = client({ user: { id: 'u1', info: { name: 'Ana' } } });
        const b = client({ user: { id: 'u2', info: { name: 'Ben' } } });
        const ca = (await subscribed(a, 'presence-room')) as unknown as { members: { count: number; get(id: string): unknown }; bind: (e: string, f: (m: unknown) => void) => void };
        const added: unknown[] = [];
        const removed: unknown[] = [];
        ca.bind('pusher:member_added', (m) => added.push(m));
        ca.bind('pusher:member_removed', (m) => removed.push(m));
        const cb = (await subscribed(b, 'presence-room')) as unknown as { members: { count: number; me: { id: string } } };
        await until(() => added.length === 1);
        expect(ca.members.count).toBe(2);
        expect(cb.members.count).toBe(2);
        expect(cb.members.me.id).toBe('u2');
        expect(added[0]).toMatchObject({ id: 'u2', info: { name: 'Ben' } });
        b.disconnect();
        await until(() => removed.length === 1);
        expect(ca.members.count).toBe(1);
    });

    it('counts one member for two sockets of the same user', async () => {
        const a = client({ user: { id: 'u1' } });
        const a2 = client({ user: { id: 'u1' } });
        const watcher = client({ user: { id: 'w' } });
        const cw = (await subscribed(watcher, 'presence-room')) as unknown as { members: { count: number }; bind: (e: string, f: (m: unknown) => void) => void };
        const removed: unknown[] = [];
        cw.bind('pusher:member_removed', (m) => removed.push(m));
        await subscribed(a, 'presence-room');
        await subscribed(a2, 'presence-room');
        await until(() => cw.members.count === 2);
        a.disconnect();
        await sleep(150);
        expect(removed).toEqual([]);
        a2.disconnect();
        await until(() => removed.length === 1);
    });

    it('relays a client event on presence, stamped with the sender the server authenticated', async () => {
        const a = client({ user: { id: 'alice' } });
        const b = client({ user: { id: 'bob' } });
        const ca = await subscribed(a, 'presence-doc');
        const cb = await subscribed(b, 'presence-doc');
        const got: Array<{ data: unknown; meta: unknown }> = [];
        cb.bind('client-cursor', (data: unknown, meta: unknown) => got.push({ data, meta }));
        const mine: unknown[] = [];
        ca.bind('client-cursor', (d: unknown) => mine.push(d));
        ca.trigger('client-cursor', { x: 1, y: 2 });
        await until(() => got.length === 1);
        expect(got[0]!.data).toEqual({ x: 1, y: 2 });
        expect(got[0]!.meta).toEqual({ user_id: 'alice' });
        await sleep(100);
        expect(mine).toEqual([]); // never echoed to the sender
    });

    it('answers pusher-js pings (activity timeout)', async () => {
        await t.stop();
        t = await startTestServer({ activityTimeout: 1, pongTimeoutMs: 400, sweepIntervalMs: 50 });
        const p = client();
        await connected(p);
        // pusher-js pings after the announced 1 s of quiet and answers the server's pings.
        await sleep(2500);
        expect(p.connection.state).toBe('connected');
    });
});

describe('Laravel Echo', () => {
    function echo(user: { id: string; info?: unknown }): Echo<'pusher'> {
        const p = client({ user });
        return new Echo({ broadcaster: 'pusher', key: t.app.key, client: p } as never) as Echo<'pusher'>;
    }

    it('listens on public, private and presence channels and whispers', async () => {
        const e1 = echo({ id: '1', info: { name: 'One' } });
        const e2 = echo({ id: '2', info: { name: 'Two' } });

        const publicGot: unknown[] = [];
        e1.channel('news').listen('.headline', (d: unknown) => publicGot.push(d));
        const privateGot: unknown[] = [];
        e1.private('account.1').listen('.Updated', (d: unknown) => privateGot.push(d));

        const here: unknown[] = [];
        const joining: unknown[] = [];
        const whispers: unknown[] = [];
        e1.join('board.1')
            .here((users: unknown[]) => here.push(users))
            .joining((u: unknown) => joining.push(u))
            .listenForWhisper('typing', (d: unknown) => whispers.push(d));
        await until(() => here.length === 1, 3000, 'here');

        const board2 = e2.join('board.1');
        await until(() => joining.length === 1, 3000, 'joining');
        expect(joining[0]).toEqual({ name: 'Two' });

        // Echo whispers are client events: `client-typing` on presence-board.1.
        await until(() => (board2 as unknown as { subscription: { subscribed: boolean } }).subscription.subscribed);
        board2.whisper('typing', { on: true });
        await until(() => whispers.length === 1, 3000, 'whisper');
        expect(whispers[0]).toEqual({ on: true });

        await sleep(100); // let the public and private subscriptions settle
        await publish('headline', ['news'], { t: 'hi' });
        await publish('Updated', ['private-account.1'], { v: 2 });
        await until(() => publicGot.length === 1 && privateGot.length === 1, 3000, 'events');
        expect(publicGot[0]).toEqual({ t: 'hi' });
        expect(privateGot[0]).toEqual({ v: 2 });
    });
});
