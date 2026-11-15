// Prove the suite has teeth: each entry removes ONE guard and names the test
// that must go red. A sabotage the suite does not notice is a test to rewrite.
//
//   node scripts/sabotage.mjs            (all)
//   node scripts/sabotage.mjs stamp      (entries whose name contains "stamp")
//
// It EDITS src/ in place and restores every file in a `finally`. Do not run it
// on a dirty src/, and never in CI: a check that mutates what it checks does
// not belong on a push.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** [name, file, [[find, replace], ...], test file, test name] */
const SABOTAGES = [
    ['trust the client\'s user_id on presence whispers', 'src/connection.ts', [['out.user_id = member.id;', 'out.user_id = (message.user_id as string | undefined) ?? member.id;']], 'test/security.test.ts', 'stamp the authenticated user_id'],
    ['forward the client\'s top-level fields', 'src/connection.ts', [['const out: Record<string, unknown> = { event, channel: name, data };', 'const out: Record<string, unknown> = { ...message, event, channel: name, data };']], 'test/security.test.ts', 'carry no user_id on private channels'],
    ['client events on by default', 'src/config.ts', [['clientEvents: app.clientEvents ?? false,', 'clientEvents: app.clientEvents ?? true,']], 'test/security.test.ts', 'are refused when the app has not enabled them'],
    ['client events on any subscribed channel', 'src/connection.ts', [["if (channel === undefined || (channel.type !== 'private' && channel.type !== 'presence')) {", 'if (channel === undefined) {']], 'test/security.test.ts', 'are refused on public and encrypted channels'],
    ['client events on channels not subscribed', 'src/connection.ts', [['const channel = socket.channels.get(name);\n    if (channel === undefined ||', 'const channel = socket.app.channels.get(name);\n    if (channel === undefined ||']], 'test/security.test.ts', 'not subscribed to a channel others are on'],
    ['no client event rate limit', 'src/connection.ts', [['if (!socket.clientEvents.take()) {', 'if (false) {']], 'test/security.test.ts', 'are rate-limited per socket'],
    ['accept any channel signature with the right key', 'src/protocol.ts', [['return safeEqualHex(auth.slice(colon + 1).toLowerCase(), expected);', 'return expected.length > 0;']], 'test/security.test.ts', 'refuses a private subscription'],
    ['ignore the key prefix of a channel signature', 'src/protocol.ts', [["if (colon < 1 || auth.slice(0, colon) !== key) {", 'if (colon < 1) {']], 'test/security.test.ts', 'another key prefix'],
    ['sign presence without channel_data', 'src/connection.ts', [['socket.id, name, data.auth, channelData)', 'socket.id, name, data.auth, undefined)']], 'test/conformance.test.ts', 'tracks presence members'],
    ['plain-object presence hash', 'src/connection.ts', [['const hash: Record<string, unknown> = Object.create(null);', 'const hash: Record<string, unknown> = {};']], 'test/security.test.ts', '__proto__'],
    ['no API signature check', 'src/http-api.ts', [["if (!safeEqualHex((query.auth_signature ?? '').toLowerCase(), expected)) {", 'if (false) {']], 'test/security.test.ts', 'a wrong secret'],
    ['no API key check', 'src/http-api.ts', [['if (query.auth_key !== app.config.key) {', 'if (false) {']], 'test/security.test.ts', 'a wrong key'],
    ['no body_md5 check', 'src/http-api.ts', [['if (body.length > 0 || query.body_md5 !== undefined) {', 'if (false) {']], 'test/security.test.ts', 'does not match body_md5'],
    ['no timestamp window', 'src/http-api.ts', [['Math.abs(host.now() - ts) > TIMESTAMP_WINDOW_S', 'false']], 'test/security.test.ts', 'timestamp 11 minutes'],
    ['accept repeated query parameters', 'src/http-api.ts', [['if (name in out) {\n            return null;\n        }', '']], 'test/security.test.ts', 'repeated query parameter'],
    ['no body cap', 'src/http-api.ts', [['if (Number.isFinite(declared) && declared > cap) {', 'if (false) {'], ['if (size > cap) {', 'if (false) {']], 'test/security.test.ts', 'oversized body'],
    ['no per-app API rate limit', 'src/http-api.ts', [['if (!app.api.take()) {', 'if (false) {']], 'test/security.test.ts', 'rate-limits the API'],
    ['no per-app message size limit', 'src/server.ts', [["if (Buffer.byteLength(data, 'utf8') > socket.app.config.limits.maxMessageBytes) {", 'if (false) {']], 'test/security.test.ts', 'larger than the app limit'],
    ['no message rate limit', 'src/server.ts', [['if (!socket.messages.take()) {', 'if (false) {']], 'test/security.test.ts', 'flooding messages'],
    ['no slow-consumer cut-off', 'src/server.ts', [['if (socket.ws.bufferedAmount > socket.app.config.limits.maxBufferedBytes) {', 'if (false) {']], 'test/security.test.ts', 'stops reading'],
    ['default connection checking (30 s)', 'src/server.ts', [['key: options.tls.key, connectionsCheckingInterval }, request)', 'key: options.tls.key }, request)'], ['createHttpServer({ connectionsCheckingInterval }, request)', 'createHttpServer(request)']], 'test/security.test.ts', 'trickles upgrade headers'],
    ['half-close a timed-out client', 'src/server.ts', [["'HTTP/1.1 400 Bad Request\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n', () => raw.destroy());", "'HTTP/1.1 400 Bad Request\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n');"], ['const cut = setTimeout(() => raw.destroy(), 1000);', 'const cut = setTimeout(() => {}, 1000);']], 'test/security.test.ts', 'trickles upgrade headers'],
    ['never close an unanswered ping', 'src/server.ts', [["hub.close(socket, CODES.pongTimeout, 'Pong reply not received.');", '']], 'test/security.test.ts', 'closes it 4201'],
    ['no per-app connection quota', 'src/server.ts', [['} else if (app.sockets.size >= app.config.limits.maxConnections) {', '} else if (false) {']], 'test/security.test.ts', "over one app's quota"],
    ['no process-wide connection cap', 'src/server.ts', [['not a WebSocket.\n        if (sockets.size >= limits.maxConnections) {', 'not a WebSocket.\n        if (false) {'], ['if (code === null && app !== undefined) {\n            if (sockets.size >= limits.maxConnections) {', 'if (code === null && app !== undefined) {\n            if (false) {']], 'test/security.test.ts', 'process-wide cap'],
    ['process-wide cap not re-checked once accepted', 'src/server.ts', [['if (code === null && app !== undefined) {\n            if (sockets.size >= limits.maxConnections) {', 'if (code === null && app !== undefined) {\n            if (false) {']], 'test/security.test.ts', 'many handshakes arrive at once'],
    ['maxFragments not handed to fancy-ws', 'src/server.ts', [['        maxFragments: limits.maxFragments,\n', '']], 'test/security.test.ts', 'more fragments than maxFragments'],
    ['no channel cap per socket', 'src/connection.ts', [['if (socket.channels.size >= app.config.limits.maxChannelsPerSocket) {', 'if (false) {']], 'test/security.test.ts', 'caps channels per socket'],
    ['no presence member cap', 'src/connection.ts', [['&& channel.users.size >= app.config.limits.maxPresenceMembers) {', '&& false) {']], 'test/security.test.ts', 'caps channels per socket'],
    ['no origin check', 'src/server.ts', [['} else if (app.config.allowedOrigins !== null &&', '} else if (false &&']], 'test/security.test.ts', 'origin not on the list'],
    ['removeApp leaves sockets open', 'src/server.ts', [["closeApp(app, CODES.appNotFound, 'App removed.');", '']], 'test/security.test.ts', 'closes only the removed app'],
    ['one channel map shared by every app', 'src/state.ts', [['export class AppState {\n    readonly sockets = new Set<Socket>();\n    readonly channels = new Map<string, Channel>();', 'const SHARED = new Map<string, Channel>();\nexport class AppState {\n    readonly sockets = new Set<Socket>();\n    readonly channels = SHARED;']], 'test/security.test.ts', "never delivers one app's events"],
    ['credential change keeps sockets', 'src/server.ts', [["closeApp(app, CODES.reconnect, 'App credentials changed.');", '']], 'test/runtime.test.ts', 'when its secret changes'],
    ['echo client events to the sender', 'src/connection.ts', [['    const serialised = JSON.stringify(out);\n    for (const other of channel.sockets) {\n        if (other !== socket) {', '    const serialised = JSON.stringify(out);\n    for (const other of channel.sockets) {\n        if (other !== socket || true) {']], 'test/conformance.test.ts', 'stamped with the sender'],
    ['ignore the publisher socket_id exclusion', 'src/server.ts', [['if (socket !== except) {', 'if (true) {']], 'test/conformance.test.ts', 'excludes the socket_id'],
];

function git(...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

if (git('status', '--porcelain', '--', 'src').trim() !== '') {
    console.error('src/ has uncommitted changes; commit or stash them first.');
    process.exit(2);
}

const filter = process.argv[2];
const todo = SABOTAGES.filter(([name]) => !filter || name.includes(filter));
const results = [];
for (const [name, file, edits, testFile, testName] of todo) {
    const path = join(root, file);
    const original = readFileSync(path, 'utf8');
    try {
        // Files are compared with LF, whatever the checkout's line endings.
        const crlf = original.includes('\r\n');
        let text = crlf ? original.split('\r\n').join('\n') : original;
        for (const [find, replace] of edits) {
            const at = text.indexOf(find);
            if (at < 0 || text.indexOf(find, at + 1) >= 0) {
                throw new Error(`the target is ${at < 0 ? 'missing' : 'not unique'}: ${find.slice(0, 60)}`);
            }
            text = text.slice(0, at) + replace + text.slice(at + find.length);
        }
        writeFileSync(path, crlf ? text.split('\n').join('\r\n') : text);
        const run = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', testFile, '-t', testName], { cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
        const out = run.stdout + run.stderr;
        const failed = run.status !== 0 && /\d+ failed/.test(out);
        const ran = /Tests\s+.*\d+ (passed|failed)/.test(out);
        results.push([name, failed ? 'CAUGHT' : ran ? 'MISSED' : 'NO TEST RAN']);
    } catch (err) {
        results.push([name, `ERROR ${err.message}`]);
    } finally {
        writeFileSync(path, original);
    }
    console.log(`${results.at(-1)[1].padEnd(12)} ${name}`);
}
const caught = results.filter(([, r]) => r === 'CAUGHT').length;
console.log(`\n${caught} of ${results.length} sabotages caught.`);
process.exit(caught === results.length ? 0 : 1);
