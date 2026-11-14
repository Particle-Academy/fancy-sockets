/**
 * The CLI, as a function so tests drive it in-process.
 *
 *   fancy-sockets --app id:key:secret[:client-events] [--app ...] [--port 6001]
 *                 [--host 127.0.0.1] [--config apps.json] [--watch]
 *                 [--tls-cert cert.pem --tls-key key.pem | --self-signed]
 *                 [--activity-timeout 30]
 *
 * The first stdout line is JSON: `{"ready":true,"url":...,"wsUrl":...,"port":...}`,
 * so a CI step can start it with `--port 0` and read the port it got.
 */
import { readFileSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { createSelfSignedCert } from './cert.js';
import { type AppConfig, DEFAULT_APP_LIMITS } from './config.js';
import { type SocketsServer, type StartOptions, start } from './server.js';

export interface CliIo {
    out(line: string): void;
    err(line: string): void;
}

export interface Parsed {
    apps: AppConfig[];
    port: number;
    host: string;
    config?: string;
    watch: boolean;
    tlsCert?: string;
    tlsKey?: string;
    selfSigned: boolean;
    caOut?: string;
    activityTimeout?: number;
    help: boolean;
}

export class UsageError extends Error {}

export const USAGE = `Usage: fancy-sockets --app id:key:secret[:client-events] [options]

  --app id:key:secret[:client-events]   an app (repeatable); add :client-events to allow them
  --config <file.json>                  apps from a JSON file: { "apps": [ {id,key,secret,...} ] }
  --watch                               re-read --config on change: apps added, updated, removed live
  --port <n>                            port (default 6001; 0 picks a free one)
  --host <addr>                         interface (default 127.0.0.1)
  --tls-cert <file> --tls-key <file>    serve wss/https with this certificate
  --self-signed                         serve wss/https with a fresh self-signed certificate
  --ca-out <file>                       with --self-signed, write the certificate to trust here
  --activity-timeout <seconds>          announced activity timeout (default 30)

The first line on stdout is JSON with the bound url, wsUrl and port.`;

function intArg(name: string, v: string | undefined): number {
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < 0) {
        throw new UsageError(`${name} needs a whole number.`);
    }
    return n;
}

export function parseArgs(argv: string[]): Parsed {
    const p: Parsed = { apps: [], port: 6001, host: '127.0.0.1', watch: false, selfSigned: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        const next = (): string => {
            const v = argv[++i];
            if (v === undefined) {
                throw new UsageError(`${arg} needs a value.`);
            }
            return v;
        };
        switch (arg) {
            case '--app': {
                const [id, key, secret, flag, ...rest] = next().split(':');
                if (!id || !key || !secret || rest.length > 0 || (flag !== undefined && flag !== 'client-events')) {
                    throw new UsageError('--app takes id:key:secret, optionally followed by :client-events.');
                }
                p.apps.push({ id, key, secret, clientEvents: flag === 'client-events' });
                break;
            }
            case '--config':
                p.config = next();
                break;
            case '--watch':
                p.watch = true;
                break;
            case '--port':
                p.port = intArg('--port', next());
                break;
            case '--host':
                p.host = next();
                break;
            case '--tls-cert':
                p.tlsCert = next();
                break;
            case '--tls-key':
                p.tlsKey = next();
                break;
            case '--self-signed':
                p.selfSigned = true;
                break;
            case '--ca-out':
                p.caOut = next();
                break;
            case '--activity-timeout':
                p.activityTimeout = intArg('--activity-timeout', next());
                break;
            case '-h':
            case '--help':
                p.help = true;
                break;
            default:
                throw new UsageError(`Unknown option ${arg}.`);
        }
    }
    if ((p.tlsCert === undefined) !== (p.tlsKey === undefined)) {
        throw new UsageError('--tls-cert and --tls-key go together.');
    }
    if (p.selfSigned && p.tlsCert !== undefined) {
        throw new UsageError('Use --self-signed or --tls-cert/--tls-key, not both.');
    }
    if (p.watch && p.config === undefined) {
        throw new UsageError('--watch needs --config.');
    }
    return p;
}

function readConfig(file: string): AppConfig[] {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { apps?: unknown };
    if (!Array.isArray(parsed.apps)) {
        throw new UsageError(`${file} must hold { "apps": [ ... ] }.`);
    }
    return parsed.apps as AppConfig[];
}

/** Applies a new app list to a running server: adds, updates and removes, each app alone. */
export function reconcile(server: SocketsServer, apps: AppConfig[], io: CliIo): void {
    const wanted = new Map(apps.map((a) => [a.id, a]));
    for (const current of server.apps()) {
        if (!wanted.has(current.id)) {
            server.removeApp(current.id);
            io.err(`fancy-sockets: removed app ${current.id}`);
        }
    }
    for (const app of apps) {
        try {
            if (server.getApp(app.id) === undefined) {
                server.addApp(app);
                io.err(`fancy-sockets: added app ${app.id}`);
            } else {
                const { id, ...patch } = app;
                server.updateApp(id, { ...patch, clientEvents: app.clientEvents ?? false, enabled: app.enabled ?? true, allowedOrigins: app.allowedOrigins ?? null, limits: { ...DEFAULT_APP_LIMITS, ...app.limits } });
            }
        } catch (err) {
            io.err(`fancy-sockets: app ${String(app.id)} not applied: ${(err as Error).message}`);
        }
    }
}

/** Runs the CLI. Resolves with the server once listening; the caller decides when to stop it. */
export async function main(argv: string[], io: CliIo, extra: Partial<StartOptions> = {}): Promise<SocketsServer | null> {
    const p = parseArgs(argv);
    if (p.help) {
        io.out(USAGE);
        return null;
    }
    const apps = [...p.apps, ...(p.config ? readConfig(p.config) : [])];
    if (apps.length === 0) {
        throw new UsageError('Give at least one --app or a --config.');
    }
    let tls: StartOptions['tls'];
    if (p.selfSigned) {
        tls = createSelfSignedCert();
        if (p.caOut) {
            writeFileSync(p.caOut, tls.cert);
        }
    } else if (p.tlsCert && p.tlsKey) {
        tls = { cert: readFileSync(p.tlsCert), key: readFileSync(p.tlsKey) };
    }
    const server = await start({
        ...extra,
        port: p.port,
        host: p.host,
        apps,
        tls,
        ...(p.activityTimeout !== undefined ? { activityTimeout: p.activityTimeout } : {}),
        log: (e) => {
            if (e.type === 'error') {
                io.err(`fancy-sockets: ${e.where}: ${e.message}`);
            }
        },
    });
    io.out(JSON.stringify({ ready: true, url: server.url, wsUrl: server.wsUrl, port: server.port, apps: server.apps().map((a) => a.id) }));

    if (p.watch && p.config) {
        const file = p.config;
        const onChange = (): void => {
            try {
                reconcile(server, readConfig(file), io);
            } catch (err) {
                io.err(`fancy-sockets: ${file} not applied: ${(err as Error).message}`);
            }
        };
        // Polling, not fs.watch: it behaves the same on Windows and Linux and
        // survives editors that replace the file.
        watchFile(file, { interval: 500 }, onChange);
        const stop = server.stop.bind(server);
        Object.assign(server, {
            stop: (o?: { timeoutMs?: number }) => {
                unwatchFile(file, onChange);
                return stop(o);
            },
        });
    }
    return server;
}
