/**
 * One socket's Pusher messages: ping/pong, subscribe, unsubscribe and client
 * events. Every handler refuses with a protocol error rather than throwing; the
 * caller still wraps it, so a bug here costs one socket, never the process.
 */
import { CODES, channelType, isValidChannelName, isValidEventName, verifyChannel } from './protocol.js';
import type { AppState, Channel, Member, Socket } from './state.js';

export interface Counters {
    messagesIn: number;
    messagesOut: number;
    refused: Record<string, number>;
}

export interface Hub {
    counters: Counters;
    /** Sends one already-serialised frame, cutting off a slow consumer. */
    send(socket: Socket, frame: string): void;
    close(socket: Socket, code: number, reason: string): void;
    refuse(kind: string): void;
}

function frame(event: string, data: unknown, channel?: string): string {
    const message: Record<string, unknown> = { event };
    if (channel !== undefined) {
        message.channel = channel;
    }
    message.data = typeof data === 'string' ? data : JSON.stringify(data);
    return JSON.stringify(message);
}

export function errorFrame(code: number | null, message: string): string {
    return JSON.stringify({ event: 'pusher:error', data: { code, message } });
}

export function establishedFrame(socketId: string, activityTimeout: number): string {
    return frame('pusher:connection_established', { socket_id: socketId, activity_timeout: activityTimeout });
}

function subscriptionError(hub: Hub, socket: Socket, channel: string, type: string, error: string, status: number): void {
    hub.refuse(`subscribe.${type}`);
    hub.send(socket, frame('pusher:subscription_error', { type, error, status }, channel));
}

/** A presence `channel_data`: `{ user_id, user_info? }`, user_id a non-empty string or finite number. */
function parseMember(raw: unknown): Member | null {
    if (typeof raw !== 'string') {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    const { user_id: id, user_info: info } = parsed as Record<string, unknown>;
    if (typeof id === 'number' && Number.isFinite(id)) {
        return { id: String(id), info: info ?? null };
    }
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
        return { id, info: info ?? null };
    }
    return null;
}

/** The presence snapshot, built on a null-prototype object so no user id can reach a prototype. */
function presenceData(channel: Channel): unknown {
    const ids: string[] = [];
    const hash: Record<string, unknown> = Object.create(null);
    for (const [id, user] of channel.users) {
        ids.push(id);
        hash[id] = user.info;
    }
    return { presence: { ids, hash, count: ids.length } };
}

function subscribe(hub: Hub, socket: Socket, data: Record<string, unknown>): void {
    const app = socket.app;
    const name = data.channel;
    if (!isValidChannelName(name)) {
        hub.refuse('subscribe.invalid');
        hub.send(socket, errorFrame(null, 'Invalid channel name.'));
        return;
    }
    if (socket.channels.has(name)) {
        // Idempotent, as Pusher: answer the subscription again, change nothing.
        const channel = socket.channels.get(name)!;
        hub.send(socket, frame('pusher_internal:subscription_succeeded', channel.type === 'presence' ? presenceData(channel) : {}, name));
        return;
    }
    if (socket.channels.size >= app.config.limits.maxChannelsPerSocket) {
        subscriptionError(hub, socket, name, 'LimitReached', 'This socket is subscribed to the maximum number of channels.', 403);
        return;
    }

    const type = channelType(name);
    let member: Member | null = null;
    if (type !== 'public') {
        let channelData: string | undefined;
        if (type === 'presence') {
            if (typeof data.channel_data !== 'string' || Buffer.byteLength(data.channel_data) > app.config.limits.maxChannelDataBytes) {
                subscriptionError(hub, socket, name, 'AuthError', 'Presence channel_data is missing or too large.', 401);
                return;
            }
            channelData = data.channel_data;
        }
        if (!verifyChannel(app.config.key, app.config.secret, socket.id, name, data.auth, channelData)) {
            subscriptionError(hub, socket, name, 'AuthError', 'Invalid signature.', 401);
            return;
        }
        if (type === 'presence') {
            member = parseMember(channelData);
            if (member === null) {
                subscriptionError(hub, socket, name, 'AuthError', 'Presence channel_data must carry a user_id.', 401);
                return;
            }
        }
    }

    const channel = app.channel(name);
    if (member !== null && !channel.users.has(member.id) && channel.users.size >= app.config.limits.maxPresenceMembers) {
        app.release(channel);
        subscriptionError(hub, socket, name, 'LimitReached', 'This presence channel has the maximum number of members.', 403);
        return;
    }

    channel.sockets.add(socket);
    socket.channels.set(name, channel);
    if (member !== null) {
        socket.members.set(name, member);
        const existing = channel.users.get(member.id);
        if (existing === undefined) {
            channel.users.set(member.id, { info: member.info, count: 1 });
            const added = frame('pusher_internal:member_added', { user_id: member.id, user_info: member.info }, name);
            for (const other of channel.sockets) {
                if (other !== socket) {
                    hub.send(other, added);
                }
            }
        } else {
            existing.count += 1;
        }
    }
    hub.send(socket, frame('pusher_internal:subscription_succeeded', type === 'presence' ? presenceData(channel) : {}, name));
}

export function unsubscribe(hub: Hub, socket: Socket, name: string): void {
    const channel = socket.channels.get(name);
    if (channel === undefined) {
        return;
    }
    socket.channels.delete(name);
    channel.sockets.delete(socket);
    const member = socket.members.get(name);
    if (member !== undefined) {
        socket.members.delete(name);
        const user = channel.users.get(member.id);
        if (user !== undefined) {
            user.count -= 1;
            if (user.count <= 0) {
                channel.users.delete(member.id);
                const removed = frame('pusher_internal:member_removed', { user_id: member.id }, name);
                for (const other of channel.sockets) {
                    hub.send(other, removed);
                }
            }
        }
    }
    socket.app.release(channel);
}

/** Removes a socket from every channel it is in. */
export function detach(hub: Hub, socket: Socket): void {
    for (const name of [...socket.channels.keys()]) {
        unsubscribe(hub, socket, name);
    }
    socket.app.sockets.delete(socket);
}

function clientEvent(hub: Hub, socket: Socket, event: string, message: Record<string, unknown>): void {
    const app = socket.app;
    const name = message.channel;
    if (!app.config.clientEvents) {
        hub.refuse('client.disabled');
        hub.send(socket, errorFrame(CODES.unauthorized, 'Client events are not enabled for this app.'));
        return;
    }
    if (!isValidEventName(event) || typeof name !== 'string') {
        hub.refuse('client.invalid');
        hub.send(socket, errorFrame(null, 'Invalid client event.'));
        return;
    }
    const channel = socket.channels.get(name);
    if (channel === undefined || (channel.type !== 'private' && channel.type !== 'presence')) {
        hub.refuse('client.channel');
        hub.send(socket, errorFrame(CODES.unauthorized, 'Client events need a subscribed private or presence channel.'));
        return;
    }
    if (!socket.clientEvents.take()) {
        hub.refuse('client.rate');
        hub.send(socket, errorFrame(CODES.rateLimited, 'Client event rejected due to rate limit.'));
        return;
    }
    const data = message.data ?? null;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : Buffer.byteLength(JSON.stringify(data));
    if (size > app.config.limits.maxEventBytes) {
        hub.refuse('client.size');
        hub.send(socket, errorFrame(null, 'Client event data is too large.'));
        return;
    }

    // The outgoing frame is built here, field by field: nothing the client put
    // at the top level survives, and on presence the sender is the member this
    // socket authenticated as, never a value the client supplied.
    const out: Record<string, unknown> = { event, channel: name, data };
    if (channel.type === 'presence') {
        const member = socket.members.get(name);
        if (member === undefined) {
            hub.refuse('client.member');
            return;
        }
        out.user_id = member.id;
    }
    const serialised = JSON.stringify(out);
    for (const other of channel.sockets) {
        if (other !== socket) {
            hub.send(other, serialised);
        }
    }
}

/** Handles one text message from a socket. */
export function handleMessage(hub: Hub, socket: Socket, raw: string): void {
    let message: unknown;
    try {
        message = JSON.parse(raw);
    } catch {
        hub.refuse('message.json');
        hub.send(socket, errorFrame(null, 'Malformed JSON.'));
        return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        hub.refuse('message.shape');
        hub.send(socket, errorFrame(null, 'A message must be a JSON object.'));
        return;
    }
    const m = message as Record<string, unknown>;
    const event = m.event;
    if (typeof event !== 'string') {
        hub.refuse('message.shape');
        hub.send(socket, errorFrame(null, 'A message needs an event name.'));
        return;
    }

    switch (event) {
        case 'pusher:ping':
            hub.send(socket, JSON.stringify({ event: 'pusher:pong', data: {} }));
            return;
        case 'pusher:pong':
            return;
        case 'pusher:subscribe':
        case 'pusher:unsubscribe': {
            let data = m.data;
            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                } catch {
                    data = null;
                }
            }
            if (data === null || typeof data !== 'object' || Array.isArray(data)) {
                hub.refuse('message.shape');
                hub.send(socket, errorFrame(null, `${event} needs a data object.`));
                return;
            }
            if (event === 'pusher:subscribe') {
                subscribe(hub, socket, data as Record<string, unknown>);
            } else if (typeof (data as Record<string, unknown>).channel === 'string') {
                unsubscribe(hub, socket, (data as Record<string, unknown>).channel as string);
            }
            return;
        }
        default:
            if (event.startsWith('client-')) {
                clientEvent(hub, socket, event, m);
            }
        // Other events are ignored, as Pusher does.
    }
}

export type { AppState };
