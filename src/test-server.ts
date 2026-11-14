import { randomBytes } from 'node:crypto';
import type { AppConfig } from './config.js';
import { createSelfSignedCert } from './cert.js';
import { type SocketsServer, type StartOptions, start } from './server.js';

export interface TestServer {
    server: SocketsServer;
    /** `http(s)://127.0.0.1:<port>`, the HTTP API base. */
    url: string;
    /** `ws(s)://127.0.0.1:<port>`. */
    wsUrl: string;
    host: string;
    port: number;
    app: { id: string; key: string; secret: string };
    /** PEM certificate to trust, when started with `tls: true`. */
    ca?: string;
    stop(): Promise<void>;
}

export interface TestServerOptions extends Omit<StartOptions, 'tls' | 'apps' | 'port'> {
    /** Port; default 0 (a free one). */
    port?: number;
    /** Overrides for the one app it creates (random id, key and secret otherwise). */
    app?: Partial<AppConfig>;
    /** `true` serves wss with a fresh self-signed certificate (see `ca`). */
    tls?: boolean | StartOptions['tls'];
}

/**
 * A server on a free port with one app and random credentials, for tests and
 * CI. Client events follow `app.clientEvents` (off unless asked for).
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
    const rand = (n: number): string => randomBytes(n).toString('hex');
    const app: AppConfig = { id: `test-${rand(4)}`, key: `key-${rand(8)}`, secret: rand(16), ...options.app };
    let tls: StartOptions['tls'];
    let ca: string | undefined;
    if (options.tls === true) {
        const made = createSelfSignedCert();
        tls = made;
        ca = made.cert;
    } else if (options.tls) {
        tls = options.tls;
    }
    const { app: _ignored, tls: _tls, ...rest } = options;
    const server = await start({ ...rest, port: options.port ?? 0, host: options.host ?? '127.0.0.1', apps: [app], tls });
    return {
        server,
        url: server.url,
        wsUrl: server.wsUrl,
        host: server.host,
        port: server.port,
        app: { id: app.id, key: app.key, secret: app.secret },
        ...(ca === undefined ? {} : { ca }),
        stop: () => server.stop({ timeoutMs: 1000 }),
    };
}
