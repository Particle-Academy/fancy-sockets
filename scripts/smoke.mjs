// Smoke-tests the BUILT artifact, which the suite (importing src/) does not:
// both entry points the manifest advertises, and the CLI binary as CI runs it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function established(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => reject(new Error(`no connection_established from ${url}`)), 5000);
        ws.on('message', (data) => {
            const frame = JSON.parse(data.toString());
            if (frame.event === 'pusher:connection_established') {
                clearTimeout(timer);
                ws.close();
                resolve(JSON.parse(frame.data).socket_id);
            }
        });
        ws.on('error', reject);
    });
}

const esm = await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
const cjs = require(join(root, 'dist', 'index.cjs'));
for (const [label, mod] of [['esm', esm], ['cjs', cjs]]) {
    for (const name of ['start', 'startTestServer', 'createSelfSignedCert', 'signChannel', 'signedApiQuery', 'CODES']) {
        if (mod[name] === undefined) {
            throw new Error(`${label} build does not export ${name}`);
        }
    }
    const t = await mod.startTestServer();
    await established(`${t.wsUrl}/app/${t.app.key}?protocol=7`);
    await t.stop();
    console.log(`${label}: ok`);
}

const cli = spawn(process.execPath, [join(root, 'dist', 'cli.js'), '--app', 'smoke:smoke-key:smoke-secret', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('the CLI printed no ready line within 10 s')), 10_000);
    cli.stdout.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
            clearTimeout(timer);
            resolve(JSON.parse(buf.slice(0, nl)));
        }
    });
    cli.on('exit', (code) => reject(new Error(`the CLI exited ${code} before it was ready`)));
});
await established(`${ready.wsUrl}/app/smoke-key?protocol=7`);
cli.kill('SIGTERM');
console.log(`cli: ok (${ready.url})`);
