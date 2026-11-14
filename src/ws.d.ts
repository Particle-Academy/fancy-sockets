// The slice of `ws` this package uses. Declared here instead of taking
// `@types/ws`, which would be a second third-party dependency for a dozen lines.
// None of these types appear in the public API.
declare module 'ws' {
    import type { IncomingMessage } from 'node:http';
    import type { Duplex } from 'node:stream';
    import { EventEmitter } from 'node:events';

    export class WebSocket extends EventEmitter {
        static readonly OPEN: 1;
        /** Client side, used by the test suite only. */
        constructor(address: string, options?: { headers?: Record<string, string>; ca?: string | Buffer });
        readonly readyState: 0 | 1 | 2 | 3;
        readonly bufferedAmount: number;
        send(data: string | Buffer, cb?: (err?: Error) => void): void;
        close(code?: number, reason?: string): void;
        terminate(): void;
        on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
        on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
        on(event: 'error', listener: (err: Error) => void): this;
        on(event: string, listener: (...args: unknown[]) => void): this;
    }

    export interface ServerOptions {
        noServer: true;
        maxPayload?: number;
        perMessageDeflate?: boolean;
        clientTracking?: boolean;
        skipUTF8Validation?: boolean;
        allowSynchronousEvents?: boolean;
        autoPong?: boolean;
    }

    export class WebSocketServer extends EventEmitter {
        constructor(options: ServerOptions);
        handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocket, req: IncomingMessage) => void): void;
        close(cb?: (err?: Error) => void): void;
    }
}
