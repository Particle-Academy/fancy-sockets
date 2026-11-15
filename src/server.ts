/**
 * The server: one HTTP(S) listener carrying the WebSocket endpoint
 * (`/app/{key}`) and the HTTP API (`/apps/{id}/...`) for every app.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { type WebSocketConnection, attachWebSocketServer } from '@particle-academy/fancy-ws';
import {
    type AppConfig,
    type GlobalLimits,
    type ResolvedApp,
    ConfigError,
    DEFAULT_GLOBAL_LIMITS,
    resolveApp,
    resolveLimits,
} from './config.js';
import { type Counters, type Hub, detach, errorFrame, establishedFrame, handleMessage } from './connection.js';
import { handleApi } from './http-api.js';
import { CODES, newSocketId } from './protocol.js';
import { AppState, Socket } from './state.js';

export interface TlsOptions {
    cert: string | Buffer;
    key: string | Buffer;
}

export interface StartOptions {
    /** Port to listen on. `0` picks a free one (read `server.port`). Default 6001. */
    port?: number;
    /** Interface to bind. Default `127.0.0.1`; use `0.0.0.0` to accept remote connections. */
    host?: string;
    apps?: AppConfig[];
    /** Serve TLS (wss / https) with this certificate. Omit behind a TLS-terminating proxy. */
    tls?: TlsOptions;
    limits?: Partial<GlobalLimits>;
    /** Seconds of silence after which a socket is pinged; announced to clients. Default 30. */
    activityTimeout?: number;
    /** After a ping, how long a socket has to answer before it is closed 4201. Default 30000 ms. */
    pongTimeoutMs?: number;
    /** How often idle sockets are checked. One timer for the whole server. Default 1000 ms. */
    sweepIntervalMs?: number;
    /** Receives operational events. Never receives a secret or a message body. */
    log?: (event: LogEvent) => void;
}

export type LogEvent =
    | { type: 'listening'; url: string }
    | { type: 'app'; action: 'added' | 'updated' | 'removed'; id: string }
    | { type: 'refused'; kind: string }
    | { type: 'error'; where: string; message: string };

export interface PublicApp {
    id: string;
    key: string;
    enabled: boolean;
    clientEvents: boolean;
    allowedOrigins: string[] | null;
    limits: ResolvedApp['limits'];
    connections: number;
    channels: number;
}

export interface Stats {
    connections: number;
    apps: number;
    messagesIn: number;
    messagesOut: number;
    refused: Record<string, number>;
}

export interface SocketsServer {
    readonly port: number;
    readonly host: string;
    /** `http(s)://host:port`, for the HTTP API. */
    readonly url: string;
    /** `ws(s)://host:port`, for clients. */
    readonly wsUrl: string;
    readonly tls: boolean;
    addApp(app: AppConfig): PublicApp;
    updateApp(id: string, patch: Partial<Omit<AppConfig, 'id'>>): PublicApp;
    removeApp(id: string): boolean;
    getApp(id: string): PublicApp | undefined;
    apps(): PublicApp[];
    stats(): Stats;
    /** Graceful: refuses new work, closes every socket 4200, waits up to `timeoutMs` (default 5000), then cuts the rest. */
    stop(options?: { timeoutMs?: number }): Promise<void>;
}

function publicApp(app: AppState): PublicApp {
    const { id, key, enabled, clientEvents, allowedOrigins, limits } = app.config;
    return { id, key, enabled, clientEvents, allowedOrigins, limits: { ...limits }, connections: app.sockets.size, channels: app.channels.size };
}

/** Starts a server and resolves once it is listening. */
export async function start(options: StartOptions = {}): Promise<SocketsServer> {
    const limits = resolveLimits(DEFAULT_GLOBAL_LIMITS, options.limits, 'limits');
    const activityTimeout = options.activityTimeout ?? 30;
    if (!Number.isInteger(activityTimeout) || activityTimeout < 1 || activityTimeout > 120) {
        throw new ConfigError('activityTimeout must be a whole number of seconds from 1 to 120.');
    }
    const pongTimeoutMs = options.pongTimeoutMs ?? 30_000;
    const sweepIntervalMs = options.sweepIntervalMs ?? 1000;
    const log = options.log ?? (() => {});

    const byId = new Map<string, AppState>();
    const byKey = new Map<string, AppState>();
    const sockets = new Map<string, Socket>();
    const counters: Counters = { messagesIn: 0, messagesOut: 0, refused: Object.create(null) };
    let stopping = false;

    const refuse = (kind: string): void => {
        counters.refused[kind] = (counters.refused[kind] ?? 0) + 1;
        log({ type: 'refused', kind });
    };

    const hub: Hub = {
        counters,
        refuse,
        send(socket, frame) {
            if (socket.closing || socket.ws.readyState !== 1) {
                return;
            }
            // A consumer that cannot keep up is cut off rather than allowed to
            // grow this process's memory without bound.
            if (socket.ws.bufferedAmount > socket.app.config.limits.maxBufferedBytes) {
                refuse('socket.slow');
                socket.closing = true;
                socket.ws.terminate();
                return;
            }
            counters.messagesOut += 1;
            socket.ws.send(frame);
        },
        close(socket, code, reason) {
            if (socket.closing) {
                return;
            }
            socket.closing = true;
            try {
                socket.ws.close(code, reason);
            } catch {
                socket.ws.terminate();
            }
        },
    };

    const closeWith = (socket: Socket, code: number, message: string): void => {
        hub.send(socket, errorFrame(code, message));
        hub.close(socket, code, message);
    };

    const onConnection = (ws: WebSocketConnection, app: AppState | undefined, initialCode: number | null, initialReason: string): void => {
        ws.on('error', () => {});
        let code = initialCode;
        let reason = initialReason;
        // Re-checked here: `verify` and this listener are an await apart, so
        // several handshakes can pass the cheap pre-checks together.
        if (code === null && app !== undefined) {
            if (sockets.size >= limits.maxConnections) {
                refuse('connect.capacity');
                code = CODES.overCapacity;
                reason = 'Server is over capacity.';
            } else if (app.sockets.size >= app.config.limits.maxConnections) {
                refuse('connect.quota');
                code = CODES.overQuota;
                reason = 'App is over its connection quota.';
            }
        }
        if (app === undefined || code !== null) {
            // Refusals are delivered in-protocol, so pusher-js reads the code and
            // knows whether to reconnect. The socket is cut if it lingers.
            ws.send(errorFrame(code ?? CODES.appNotFound, reason));
            ws.close(code ?? CODES.appNotFound, reason);
            const timer = setTimeout(() => ws.terminate(), 2000);
            timer.unref();
            ws.on('close', () => clearTimeout(timer));
            return;
        }
        let id = newSocketId();
        while (sockets.has(id)) {
            id = newSocketId();
        }
        const socket = new Socket(id, ws, app);
        sockets.set(id, socket);
        app.sockets.add(socket);

        ws.on('message', (data: string | Buffer, isBinary: boolean) => {
            socket.lastSeen = performance.now();
            socket.pingSentAt = null;
            counters.messagesIn += 1;
            if (socket.closing) {
                return;
            }
            if (isBinary || typeof data !== 'string') {
                refuse('message.binary');
                hub.close(socket, CODES.unsupportedData, 'Binary messages are not supported.');
                return;
            }
            // fancy-ws has already decoded and UTF-8-validated the text, under
            // the process-wide frame cap; this is the app's own, smaller one.
            if (Buffer.byteLength(data, 'utf8') > socket.app.config.limits.maxMessageBytes) {
                refuse('message.size');
                hub.close(socket, CODES.messageTooBig, 'Message too big.');
                return;
            }
            if (!socket.messages.take()) {
                refuse('message.rate');
                closeWith(socket, CODES.rateLimited, 'Too many messages.');
                return;
            }
            try {
                handleMessage(hub, socket, data);
            } catch (err) {
                log({ type: 'error', where: 'message', message: (err as Error).message });
                hub.close(socket, 4200, 'Internal error.');
            }
        });
        ws.on('close', () => {
            sockets.delete(socket.id);
            detach(hub, socket);
        });
        ws.send(establishedFrame(id, activityTimeout));
    };

    /**
     * fancy-ws's `verify`, run BEFORE the 101. A number refuses at the
     * handshake with that HTTP status; an object accepts and reaches
     * `onConnection`. Only what costs nothing to refuse is refused here (the
     * process-wide cap, a wrong path): a missing or disabled app is accepted and
     * closed with its Pusher code, because pusher-js decides whether to
     * reconnect from that code and treats an HTTP refusal as "retry forever".
     */
    const verify = (req: IncomingMessage): number | { app: AppState | undefined; code: number | null; reason: string } => {
        const reject = (status: number): number => {
            refuse(`upgrade.${status}`);
            return status;
        };
        if (stopping) {
            return reject(503);
        }
        // The process-wide cap is checked before the handshake, so a flood of
        // connections costs a status line each, not a WebSocket.
        if (sockets.size >= limits.maxConnections) {
            return reject(503);
        }
        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://localhost');
        } catch {
            return reject(400);
        }
        const match = /^\/app\/([^/]+)$/.exec(url.pathname);
        if (match === null) {
            return reject(404);
        }
        let key: string;
        try {
            key = decodeURIComponent(match[1]!);
        } catch {
            return reject(400);
        }
        const app = byKey.get(key);
        let code: number | null = null;
        let reason = '';
        const protocol = Number(url.searchParams.get('protocol') ?? '7');
        if (app === undefined) {
            refuse('connect.app');
            code = CODES.appNotFound;
            reason = 'App does not exist.';
        } else if (!app.config.enabled) {
            refuse('connect.disabled');
            code = CODES.appDisabled;
            reason = 'App is disabled.';
        } else if (!Number.isInteger(protocol) || protocol < 5 || protocol > 7) {
            refuse('connect.protocol');
            code = CODES.invalidVersion;
            reason = 'Unsupported protocol version.';
        } else if (app.config.allowedOrigins !== null && !app.config.allowedOrigins.includes(String(req.headers.origin ?? ''))) {
            refuse('connect.origin');
            code = CODES.unauthorized;
            reason = 'Origin not allowed.';
        }
        // The per-app quota is checked once the socket is ours (onConnection),
        // where it cannot race another handshake.
        return { app, code, reason };
    };

    const request = (req: IncomingMessage, res: ServerResponse): void => {
        req.on('error', () => {});
        if (stopping) {
            res.writeHead(503, { connection: 'close' }).end();
            return;
        }
        let url: URL;
        try {
            url = new URL(req.url ?? '/', 'http://localhost');
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (url.pathname === '/up' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            return;
        }
        handleApi(
            {
                findApp: (id) => byId.get(id),
                maxBodyBytes: limits.maxBodyBytes,
                now: () => Math.floor(Date.now() / 1000),
                refuse,
                publish(app, name, frame, except) {
                    const channel = app.channels.get(name);
                    if (channel === undefined) {
                        return;
                    }
                    for (const socket of channel.sockets) {
                        if (socket !== except) {
                            hub.send(socket, frame);
                        }
                    }
                },
                socketById(app, id) {
                    const socket = sockets.get(id);
                    return socket?.app === app ? socket : undefined;
                },
            },
            req,
            res,
            url,
        )
            .then((handled) => {
                if (!handled && !res.headersSent) {
                    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}');
                }
            })
            .catch((err: Error) => {
                log({ type: 'error', where: 'api', message: err.message });
                if (!res.headersSent) {
                    res.writeHead(500).end();
                } else {
                    res.destroy();
                }
            });
    };

    // Node enforces headersTimeout only when it checks connections, every 30 s
    // by default: a slowloris would get 30 s per connection. Check often enough
    // that the configured timeout is the one that holds.
    const connectionsCheckingInterval = Math.max(50, Math.min(1000, Math.floor(limits.headersTimeoutMs / 4)));
    const http: HttpServer = options.tls
        ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, connectionsCheckingInterval }, request)
        : createHttpServer({ connectionsCheckingInterval }, request);
    // Slowloris: a client trickling headers (an upgrade included) is cut off.
    http.headersTimeout = limits.headersTimeoutMs;
    http.requestTimeout = limits.requestTimeoutMs;
    http.keepAliveTimeout = 5000;
    // RFC 6455 framing is fancy-ws (first-party, zero dependencies). Every
    // upgrade on this listener is ours, so there is no `path`: `verify` routes.
    const wss = attachWebSocketServer(http, {
        verify,
        maxPayload: limits.maxMessageBytes,
        maxFragments: limits.maxFragments,
        closeTimeoutMs: 5000,
    });
    wss.on('error', (err) => log({ type: 'error', where: 'upgrade', message: err.message }));
    wss.on('connection', (ws, _req, verified) => {
        const v = verified as { app?: AppState; code?: number | null; reason?: string };
        onConnection(ws, v.app, v.code ?? null, v.reason ?? '');
    });
    http.on('clientError', (err: NodeJS.ErrnoException, raw) => {
        const timeout = err.code === 'ERR_HTTP_REQUEST_TIMEOUT';
        if (timeout) {
            refuse('http.timeout');
        }
        // `end()` alone only half-closes: a client still trickling headers
        // keeps the socket. Destroy once the status line is flushed.
        if (raw.writable) {
            raw.end(timeout ? 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n' : 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => raw.destroy());
            const cut = setTimeout(() => raw.destroy(), 1000);
            cut.unref();
        } else {
            raw.destroy();
        }
    });

    // ---- idle sockets: ONE sweep for the whole server, not a timer per socket.
    const sweep = setInterval(() => {
        const now = performance.now();
        const idleMs = activityTimeout * 1000;
        for (const socket of sockets.values()) {
            if (socket.closing) {
                continue;
            }
            if (socket.pingSentAt !== null) {
                if (now - socket.pingSentAt > pongTimeoutMs) {
                    refuse('socket.pong');
                    hub.close(socket, CODES.pongTimeout, 'Pong reply not received.');
                }
            } else if (now - socket.lastSeen > idleMs) {
                socket.pingSentAt = now;
                hub.send(socket, JSON.stringify({ event: 'pusher:ping', data: {} }));
            }
        }
    }, sweepIntervalMs);
    sweep.unref();

    // ---- runtime apps
    const addApp = (config: AppConfig): PublicApp => {
        const resolved = resolveApp(config);
        if (byId.has(resolved.id)) {
            throw new ConfigError(`App ${resolved.id} already exists.`);
        }
        if (byKey.has(resolved.key)) {
            throw new ConfigError(`App ${resolved.id}: another app already uses that key.`);
        }
        const app = new AppState(resolved);
        byId.set(resolved.id, app);
        byKey.set(resolved.key, app);
        log({ type: 'app', action: 'added', id: resolved.id });
        return publicApp(app);
    };

    const closeApp = (app: AppState, code: number, reason: string): void => {
        for (const socket of [...app.sockets]) {
            closeWith(socket, code, reason);
        }
    };

    const updateApp = (id: string, patch: Partial<Omit<AppConfig, 'id'>>): PublicApp => {
        const app = byId.get(id);
        if (app === undefined) {
            throw new ConfigError(`App ${id} does not exist.`);
        }
        const current = app.config;
        const next = resolveApp({
            id,
            key: patch.key ?? current.key,
            secret: patch.secret ?? current.secret,
            enabled: patch.enabled ?? current.enabled,
            clientEvents: patch.clientEvents ?? current.clientEvents,
            allowedOrigins: patch.allowedOrigins === undefined ? current.allowedOrigins : patch.allowedOrigins,
            limits: { ...current.limits, ...patch.limits },
        });
        if (next.key !== current.key && byKey.has(next.key)) {
            throw new ConfigError(`App ${id}: another app already uses that key.`);
        }
        byKey.delete(current.key);
        byKey.set(next.key, app);
        app.reconfigure(next);
        if (!next.enabled && current.enabled) {
            closeApp(app, CODES.appDisabled, 'App is disabled.');
        } else if (next.key !== current.key || next.secret !== current.secret) {
            // Their subscriptions were signed with the old credentials.
            closeApp(app, CODES.reconnect, 'App credentials changed.');
        }
        log({ type: 'app', action: 'updated', id });
        return publicApp(app);
    };

    const removeApp = (id: string): boolean => {
        const app = byId.get(id);
        if (app === undefined) {
            return false;
        }
        byId.delete(id);
        byKey.delete(app.config.key);
        closeApp(app, CODES.appNotFound, 'App removed.');
        log({ type: 'app', action: 'removed', id });
        return true;
    };

    for (const app of options.apps ?? []) {
        addApp(app);
    }

    const host = options.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(options.port ?? 6001, host, () => {
            http.off('error', reject);
            resolve();
        });
    });
    http.on('error', (err) => log({ type: 'error', where: 'listener', message: err.message }));
    const port = (http.address() as AddressInfo).port;
    const urlHost = host.includes(':') ? `[${host}]` : host;
    const tls = options.tls !== undefined;
    const url = `${tls ? 'https' : 'http'}://${urlHost}:${port}`;
    log({ type: 'listening', url });

    let stopped: Promise<void> | null = null;

    return {
        port,
        host,
        url,
        wsUrl: `${tls ? 'wss' : 'ws'}://${urlHost}:${port}`,
        tls,
        addApp,
        updateApp,
        removeApp,
        getApp: (id) => {
            const app = byId.get(id);
            return app === undefined ? undefined : publicApp(app);
        },
        apps: () => [...byId.values()].map(publicApp),
        stats: () => ({
            connections: sockets.size,
            apps: byId.size,
            messagesIn: counters.messagesIn,
            messagesOut: counters.messagesOut,
            refused: { ...counters.refused },
        }),
        stop({ timeoutMs = 5000 } = {}) {
            if (stopped !== null) {
                return stopped;
            }
            stopping = true;
            clearInterval(sweep);
            stopped = new Promise<void>((resolve) => {
                const closed = new Promise<void>((done) => http.close(() => done()));
                for (const socket of sockets.values()) {
                    closeWith(socket, CODES.reconnect, 'Server shutting down.');
                }
                http.closeIdleConnections();
                const deadline = setTimeout(() => {
                    for (const socket of sockets.values()) {
                        socket.ws.terminate();
                    }
                    http.closeAllConnections();
                }, timeoutMs);
                deadline.unref();
                closed.then(() => {
                    clearTimeout(deadline);
                    wss.detach();
                    resolve();
                });
                // A server with no sockets left closes as soon as idle HTTP ends.
                const poll = setInterval(() => {
                    if (sockets.size === 0) {
                        clearInterval(poll);
                        http.closeAllConnections();
                    }
                }, 20);
                poll.unref();
            });
            return stopped;
        },
    };
}
