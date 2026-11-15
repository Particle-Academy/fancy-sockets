/**
 * A minimal RFC 6455 CLIENT for the suite, over node:net / node:tls.
 *
 * Why not Node's `WebSocket` global: it cannot send an `Origin` header, cannot
 * take a CA, and hides the HTTP status of a refused handshake, and the tests
 * need all three. Why not fancy-ws: it is the server half under test, and a
 * client sharing its frame codec would check the server against itself (the
 * same reason `sign()` in helpers.ts does not use src/protocol.ts).
 *
 * It mirrors the slice of the `ws` client API the suite used: `open`,
 * `message(data, isBinary)`, `close(code, reason)`, `error`,
 * `unexpected-response(req, { statusCode })`, `readyState`, `send`, `close`.
 * Pings are answered automatically, as `ws` did.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type Socket, connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HEADER_END = Buffer.from('\r\n\r\n');

export interface WsClientOptions {
    headers?: Record<string, string>;
    /** PEM CA for wss:// (the test server's self-signed certificate). */
    ca?: string;
}

export class WsClient extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = WsClient.CONNECTING;

    private readonly socket: Socket;
    private buffer: Buffer = Buffer.alloc(0);
    private handshakeDone = false;
    private readonly key = randomBytes(16).toString('base64');
    private fragments: Buffer[] = [];
    private fragmentOpcode = 0;
    private closeSent = false;
    private closeCode = 1006;
    private closeReason: Buffer = Buffer.alloc(0);
    private closeEmitted = false;

    constructor(url: string, options: WsClientOptions = {}) {
        super();
        const u = new URL(url);
        const secure = u.protocol === 'wss:';
        if (!secure && u.protocol !== 'ws:') {
            throw new Error(`not a WebSocket URL: ${url}`);
        }
        const port = Number(u.port || (secure ? 443 : 80));
        const host = u.hostname.replace(/^\[|\]$/g, '');
        this.socket = secure
            ? tlsConnect({ host, port, servername: /^[\d.]+$|:/.test(host) ? undefined : host, ...(options.ca ? { ca: options.ca } : {}) })
            : netConnect({ host, port });

        const headers: Record<string, string> = {
            Host: u.host,
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'Sec-WebSocket-Key': this.key,
            'Sec-WebSocket-Version': '13',
            ...options.headers,
        };
        const request = `GET ${u.pathname}${u.search} HTTP/1.1\r\n${Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n')}\r\n\r\n`;

        this.socket.once(secure ? 'secureConnect' : 'connect', () => this.socket.write(request));
        this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
        this.socket.on('error', (err) => this.emit('error', err));
        this.socket.on('close', () => this.finish());
    }

    send(data: string | Buffer): void {
        if (this.readyState !== WsClient.OPEN) {
            throw new Error('WebSocket is not open');
        }
        const text = typeof data === 'string';
        this.writeFrame(text ? 0x1 : 0x2, text ? Buffer.from(data, 'utf8') : data);
    }

    /** One text message split into `parts.length` frames (fragmentation tests). */
    sendFragments(parts: string[]): void {
        if (this.readyState !== WsClient.OPEN) {
            throw new Error('WebSocket is not open');
        }
        parts.forEach((part, i) => {
            this.writeFrame(i === 0 ? 0x1 : 0x0, Buffer.from(part, 'utf8'), i === parts.length - 1);
        });
    }

    close(code = 1000, reason = ''): void {
        if (this.readyState === WsClient.CLOSED || this.closeSent) {
            return;
        }
        if (this.readyState === WsClient.CONNECTING) {
            this.socket.destroy();
            return;
        }
        this.readyState = WsClient.CLOSING;
        this.sendClose(code, reason);
        // The server answers with its own close and ends the TCP stream; do
        // not wait for it forever.
        setTimeout(() => this.socket.destroy(), 2000).unref();
    }

    /** Cuts the TCP connection with no close handshake. */
    terminate(): void {
        this.socket.destroy();
    }

    private sendClose(code: number, reason: string): void {
        this.closeSent = true;
        const r = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + r.length);
        payload.writeUInt16BE(code, 0);
        r.copy(payload, 2);
        this.writeFrame(0x8, payload);
    }

    private writeFrame(opcode: number, payload: Buffer, fin = true): void {
        const len = payload.length;
        const head = len < 126 ? 2 : len < 65_536 ? 4 : 10;
        const frame = Buffer.alloc(head + 4 + len);
        frame[0] = (fin ? 0x80 : 0) | opcode;
        if (len < 126) {
            frame[1] = 0x80 | len;
        } else if (len < 65_536) {
            frame[1] = 0x80 | 126;
            frame.writeUInt16BE(len, 2);
        } else {
            frame[1] = 0x80 | 127;
            frame.writeBigUInt64BE(BigInt(len), 2);
        }
        const mask = randomBytes(4);
        mask.copy(frame, head);
        for (let i = 0; i < len; i++) {
            frame[head + 4 + i] = payload[i]! ^ mask[i & 3]!;
        }
        if (!this.socket.destroyed) {
            this.socket.write(frame);
        }
    }

    private onData(chunk: Buffer): void {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        if (!this.handshakeDone) {
            const end = this.buffer.indexOf(HEADER_END);
            if (end === -1) {
                return;
            }
            const head = this.buffer.subarray(0, end).toString('latin1');
            this.buffer = this.buffer.subarray(end + HEADER_END.length);
            if (!this.onHandshake(head)) {
                return;
            }
        }
        this.readFrames();
    }

    private onHandshake(head: string): boolean {
        const [statusLine = '', ...lines] = head.split('\r\n');
        const statusCode = Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1] ?? 0);
        const headers: Record<string, string> = {};
        for (const line of lines) {
            const i = line.indexOf(':');
            if (i > 0) {
                headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
        }
        if (statusCode !== 101) {
            this.emit('unexpected-response', null, { statusCode, headers });
            this.socket.destroy();
            return false;
        }
        const expected = createHash('sha1').update(this.key + GUID).digest('base64');
        if (headers['sec-websocket-accept'] !== expected || headers.upgrade?.toLowerCase() !== 'websocket') {
            this.emit('error', new Error('invalid handshake response'));
            this.socket.destroy();
            return false;
        }
        this.handshakeDone = true;
        this.readyState = WsClient.OPEN;
        this.emit('open');
        return true;
    }

    private readFrames(): void {
        for (;;) {
            if (this.buffer.length < 2) {
                return;
            }
            const b0 = this.buffer[0]!;
            const b1 = this.buffer[1]!;
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            if ((b1 & 0x80) !== 0) {
                this.fail('server frames must not be masked');
                return;
            }
            let len = b1 & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (this.buffer.length < 4) {
                    return;
                }
                len = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (len === 127) {
                if (this.buffer.length < 10) {
                    return;
                }
                len = Number(this.buffer.readBigUInt64BE(2));
                offset = 10;
            }
            if (this.buffer.length < offset + len) {
                return;
            }
            const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
            this.buffer = this.buffer.subarray(offset + len);
            this.onFrame(fin, opcode, payload);
            if (this.socket.destroyed) {
                return;
            }
        }
    }

    private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
        switch (opcode) {
            case 0x0:
            case 0x1:
            case 0x2: {
                if (opcode !== 0x0) {
                    this.fragmentOpcode = opcode;
                    this.fragments = [];
                }
                this.fragments.push(payload);
                if (fin) {
                    const data = Buffer.concat(this.fragments);
                    this.fragments = [];
                    this.emit('message', data, this.fragmentOpcode === 0x2);
                }
                return;
            }
            case 0x8: {
                this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                this.closeReason = payload.length > 2 ? payload.subarray(2) : Buffer.alloc(0);
                this.readyState = WsClient.CLOSING;
                if (!this.closeSent) {
                    // Echo the code, as RFC 6455 5.5.1 asks and `ws` does.
                    this.sendClose(payload.length >= 2 ? this.closeCode : 1000, '');
                }
                this.socket.end();
                setTimeout(() => this.socket.destroy(), 2000).unref();
                return;
            }
            case 0x9:
                this.writeFrame(0xa, payload);
                this.emit('ping', payload);
                return;
            case 0xa:
                this.emit('pong', payload);
                return;
            default:
                this.fail(`unknown opcode ${opcode}`);
        }
    }

    private fail(message: string): void {
        this.emit('error', new Error(message));
        this.socket.destroy();
    }

    private finish(): void {
        this.readyState = WsClient.CLOSED;
        if (this.closeEmitted) {
            return;
        }
        this.closeEmitted = true;
        this.emit('close', this.closeCode, this.closeReason);
    }
}
