/**
 * The HTTP API against fancy-cowork-php's own publisher (the `fancy-pusher`
 * driver, pusher-php-server's wire format) — real PHP, not a port of it.
 *
 * Needs `php` and a fancy-cowork-php checkout with `vendor/` installed:
 * FANCY_COWORK_PHP_DIR, or ../fancy-cowork-php beside this repo. CI sets
 * FANCY_SOCKETS_REQUIRE_PHP=1, which turns a missing prerequisite into a
 * FAILURE: a suite that quietly skips its interop test reports green about
 * nothing.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestServer, startTestServer } from '../src/test-server.js';
import { raw, rawUrl, sleep } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const coworkDir = process.env.FANCY_COWORK_PHP_DIR ?? resolve(here, '../../fancy-cowork-php');
const required = process.env.FANCY_SOCKETS_REQUIRE_PHP === '1';

function phpVersion(): Promise<string | null> {
    return new Promise((res) => execFile('php', ['-r', 'echo PHP_VERSION;'], (err, out) => res(err ? null : out.trim())));
}

const available = existsSync(join(coworkDir, 'vendor', 'autoload.php')) && existsSync(join(coworkDir, 'src', 'Broadcasting', 'PusherHttpClient.php'));

function publish(t: TestServer, extra: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const config = { host: '127.0.0.1', port: t.port, app_id: t.app.id, key: t.app.key, secret: t.app.secret, event: 'order.shipped', payload: { id: 7 }, channels: ['orders'], ...extra };
    return new Promise((res, rej) =>
        execFile('php', [join(here, 'php', 'publish.php'), coworkDir, JSON.stringify(config)], { timeout: 20_000 }, (err, out, errOut) => {
            if (err) {
                rej(new Error(`php failed: ${errOut || err.message}`));
                return;
            }
            res(JSON.parse(out.trim().split('\n').pop()!));
        }),
    );
}

describe('fancy-cowork-php publisher', () => {
    it('has its prerequisites (php and a fancy-cowork-php checkout)', async () => {
        const version = await phpVersion();
        if (required) {
            expect(version, 'php is not on PATH').not.toBeNull();
            expect(available, `no fancy-cowork-php with vendor/ at ${coworkDir}`).toBe(true);
        } else if (version === null || !available) {
            console.warn(`[php-publisher] SKIPPED: php=${version ?? 'missing'}, fancy-cowork-php at ${coworkDir} ${available ? 'found' : 'missing'}. Set FANCY_SOCKETS_REQUIRE_PHP=1 to make this fail.`);
        }
    });

    describe.runIf(available)('with php', () => {
        let t: TestServer;
        beforeEach(async () => {
            t = await startTestServer();
        });
        afterEach(async () => {
            await t.stop();
        });

        it('delivers an event published with PusherHttpClient', async () => {
            const r = await raw(rawUrl(t));
            r.send({ event: 'pusher:subscribe', data: { channel: 'orders' } });
            await r.next('pusher_internal:subscription_succeeded');
            expect(await publish(t, {})).toEqual({ ok: true });
            const got = await r.next('order.shipped', 10_000);
            expect(JSON.parse(got.data as string)).toEqual({ id: 7 });
        });

        it('honours the socket_id exclusion it sends', async () => {
            const a = await raw(rawUrl(t));
            const b = await raw(rawUrl(t));
            for (const r of [a, b]) {
                r.send({ event: 'pusher:subscribe', data: { channel: 'orders' } });
                await r.next('pusher_internal:subscription_succeeded');
            }
            expect(await publish(t, { socket_id: a.socketId() })).toEqual({ ok: true });
            await b.next('order.shipped', 10_000);
            await sleep(100);
            expect(a.frames.some((f) => f.event === 'order.shipped')).toBe(false);
        });

        it('is refused when it signs with the wrong secret', async () => {
            const result = await publish(t, { secret_override: 'not-the-secret' });
            expect(result.ok).toBe(false);
            expect(result.error).toContain('401');
        });
    });
});
