// Builds the fancy-ws tarball package-lock.json resolves to while fancy-ws
// 0.2.0 is not on npm (see fancy-ws-candidate.json). Run before `npm ci`:
//
//   node scripts/fancy-ws-candidate.mjs        (npm run candidates)
//
// Clones Particle-Academy/fancy-ws at the pinned commit with LF line endings
// (so the build is the same bytes on every OS), verifies the checkout IS that
// commit, builds it, packs it to .fancy-ws-candidate/fancy-ws.tgz, and checks
// the tarball's sha512 against the integrity the lockfile records. A tarball
// that does not match fails here, before npm installs anything.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pinned = JSON.parse(readFileSync(join(root, 'fancy-ws-candidate.json'), 'utf8'));
const out = join(root, '.fancy-ws-candidate');
const tarball = join(out, 'fancy-ws.tgz');
const marker = join(out, 'built.json');
const shell = process.platform === 'win32';
// npm and npx are .cmd shims on Windows, which Node runs only through a shell; git is not.
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: shell && cmd !== 'git' });

if (!/^[0-9a-f]{40}$/.test(pinned.commit)) {
    throw new Error('fancy-ws-candidate.json: commit must be a full 40-character sha.');
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const entry = lock.packages?.['node_modules/@particle-academy/fancy-ws'];
const integrity = entry?.integrity;

function sri(file) {
    return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
}

const built = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
if (built?.commit === pinned.commit && existsSync(tarball) && (!integrity || sri(tarball) === integrity)) {
    console.log(`fancy-ws candidate ${pinned.commit.slice(0, 7)}: already built`);
    process.exit(0);
}

rmSync(out, { recursive: true, force: true });
const src = join(out, 'src');
run('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-checkout', 'https://github.com/Particle-Academy/fancy-ws.git', src], root);
run('git', ['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'checkout', '--quiet', pinned.commit], src);
const head = run('git', ['rev-parse', 'HEAD'], src).trim();
if (head !== pinned.commit) {
    throw new Error(`fancy-ws checkout is at ${head}, pinned ${pinned.commit}.`);
}
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
if (version !== pinned.version) {
    throw new Error(`fancy-ws at ${pinned.commit} is ${version}, pinned ${pinned.version}.`);
}
run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], src);
run('npx', ['tsup'], src);
const packed = run('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', out], src).trim().split('\n').pop();
renameSync(join(out, packed), tarball);
rmSync(src, { recursive: true, force: true });

const got = sri(tarball);
if (integrity && got !== integrity) {
    throw new Error(`The fancy-ws tarball built from ${pinned.commit} is ${got}, but package-lock.json records ${integrity}. The build is not reproducing; do not install it.`);
}
writeFileSync(marker, JSON.stringify({ commit: pinned.commit, version, integrity: got }, null, 2));
console.log(`fancy-ws candidate ${pinned.commit.slice(0, 7)} (${version}): ${got}`);
