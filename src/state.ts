/**
 * Per-app runtime state: its sockets and its channels. Every app owns its own
 * maps, so no lookup can cross from one app into another.
 */
import type { WebSocketConnection } from '@particle-academy/fancy-ws';
import type { ResolvedApp } from './config.js';
import { type ChannelType, RateLimiter, channelType } from './protocol.js';

export interface Member {
    id: string;
    info: unknown;
}

export class Socket {
    readonly channels = new Map<string, Channel>();
    /** The presence member this socket authenticated as, per presence channel. */
    readonly members = new Map<string, Member>();
    lastSeen = performance.now();
    pingSentAt: number | null = null;
    closing = false;
    messages: RateLimiter;
    clientEvents: RateLimiter;

    constructor(
        readonly id: string,
        readonly ws: WebSocketConnection,
        public app: AppState,
    ) {
        this.messages = new RateLimiter(app.config.limits.messagesPerSecond);
        this.clientEvents = new RateLimiter(app.config.limits.clientEventsPerSecond);
    }
}

export class Channel {
    readonly type: ChannelType;
    readonly sockets = new Set<Socket>();
    /** Presence only: user id to its info and how many of its sockets are here. */
    readonly users = new Map<string, { info: unknown; count: number }>();

    constructor(readonly name: string) {
        this.type = channelType(name);
    }
}

export class AppState {
    readonly sockets = new Set<Socket>();
    readonly channels = new Map<string, Channel>();
    api: RateLimiter;

    constructor(public config: ResolvedApp) {
        this.api = new RateLimiter(config.limits.apiRequestsPerSecond);
    }

    /** Applies new limits to live rate limiters without resetting anyone's budget. */
    reconfigure(config: ResolvedApp): void {
        this.config = config;
        this.api.rate = config.limits.apiRequestsPerSecond;
        for (const socket of this.sockets) {
            socket.messages.rate = config.limits.messagesPerSecond;
            socket.clientEvents.rate = config.limits.clientEventsPerSecond;
        }
    }

    channel(name: string): Channel {
        let channel = this.channels.get(name);
        if (channel === undefined) {
            channel = new Channel(name);
            this.channels.set(name, channel);
        }
        return channel;
    }

    /** Drops a channel nobody is subscribed to, so an idle app holds no memory for it. */
    release(channel: Channel): void {
        if (channel.sockets.size === 0) {
            this.channels.delete(channel.name);
        }
    }
}
