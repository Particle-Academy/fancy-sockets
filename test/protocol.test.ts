import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    RateLimiter,
    apiStringToSign,
    channelType,
    isValidChannelName,
    signApiRequest,
    signChannel,
    signedApiQuery,
    verifyChannel,
} from '../src/protocol.js';

/*
 * The Pusher protocol's own worked examples, the same vectors fancy-cowork-php
 * pins in tests/Unit/PusherProtocolTest.php. Both sides agreeing on these is
 * what makes "compatible with that publisher" a test result.
 */
const DOC_KEY = '278d425bdf160c739803';
const DOC_SECRET = '7ad3773142a6692b25b8';

describe('signatures (shared vectors with fancy-cowork-php)', () => {
    it('signs the documented events request', () => {
        const body = '{"name":"foo","channels":["project-3"],"data":"{\\"some\\":\\"data\\"}"}';
        const query = signedApiQuery(DOC_KEY, DOC_SECRET, 'POST', '/apps/3/events', body, {}, 1353088179);
        expect(query).toEqual({
            auth_key: DOC_KEY,
            auth_timestamp: '1353088179',
            auth_version: '1.0',
            body_md5: 'ec365a775a4cd0599faeb73354201b6f',
            auth_signature: 'da454824c97ba181a32ccc17a72625ba02771f50b50e1e7430e47a1f3f457e6c',
        });
    });

    it('signs the documented private channel', () => {
        expect(signChannel(DOC_KEY, DOC_SECRET, '1234.1234', 'private-foobar')).toBe(
            `${DOC_KEY}:58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4`,
        );
    });

    it('signs presence over socket, channel and the exact channel_data string', () => {
        const data = '{"user_id":"a","user_info":{"ref":"a"}}';
        const expected = createHmac('sha256', DOC_SECRET).update(`1234.1234:presence-room:${data}`).digest('hex');
        expect(signChannel(DOC_KEY, DOC_SECRET, '1234.1234', 'presence-room', data)).toBe(`${DOC_KEY}:${expected}`);
    });

    it('builds the string to sign from method, path and sorted parameters', () => {
        expect(apiStringToSign('post', '/apps/1/events', { b: '2', a: '1', auth_key: 'k' })).toBe('POST\n/apps/1/events\na=1&auth_key=k&b=2');
    });

    it('never signs over an auth_signature it was handed', () => {
        expect(signApiRequest('s', 'POST', '/p', { a: '1', auth_signature: 'forged' })).toBe(signApiRequest('s', 'POST', '/p', { a: '1' }));
    });
});

describe('verifyChannel', () => {
    const good = signChannel('key', 'secret-123', '1.2', 'private-x');

    it('accepts the right signature', () => {
        expect(verifyChannel('key', 'secret-123', '1.2', 'private-x', good)).toBe(true);
    });

    it.each([
        ['another socket', '1.3', 'private-x', good],
        ['another channel', '1.2', 'private-y', good],
        ['another key prefix', '1.2', 'private-x', good.replace(/^key/, 'kez')],
        ['a truncated signature', '1.2', 'private-x', good.slice(0, -1)],
        ['no key', '1.2', 'private-x', good.slice(4)],
        ['a non-string', '1.2', 'private-x', 42],
        ['an empty string', '1.2', 'private-x', ''],
    ])('refuses %s', (_label, socket, channel, auth) => {
        expect(verifyChannel('key', 'secret-123', socket as string, channel as string, auth)).toBe(false);
    });

    it('refuses a signature made with another secret', () => {
        expect(verifyChannel('key', 'secret-123', '1.2', 'private-x', signChannel('key', 'other-secret', '1.2', 'private-x'))).toBe(false);
    });

    it('binds presence channel_data byte for byte', () => {
        const data = '{"user_id":"1"}';
        const auth = signChannel('key', 'secret-123', '1.2', 'presence-r', data);
        expect(verifyChannel('key', 'secret-123', '1.2', 'presence-r', auth, data)).toBe(true);
        expect(verifyChannel('key', 'secret-123', '1.2', 'presence-r', auth, '{"user_id":"2"}')).toBe(false);
    });
});

describe('names', () => {
    it('classifies channels', () => {
        expect(channelType('orders')).toBe('public');
        expect(channelType('private-a')).toBe('private');
        expect(channelType('private-encrypted-a')).toBe('encrypted');
        expect(channelType('presence-a')).toBe('presence');
    });

    it('validates channel names', () => {
        expect(isValidChannelName('presence-room.1_a-b=c@d,e;f')).toBe(true);
        expect(isValidChannelName('#server-to-user-1')).toBe(false);
        expect(isValidChannelName('a b')).toBe(false);
        expect(isValidChannelName('x'.repeat(201))).toBe(false);
        expect(isValidChannelName('')).toBe(false);
        expect(isValidChannelName(7)).toBe(false);
    });
});

describe('RateLimiter', () => {
    it('allows a burst of `rate`, then refills at `rate` per second', () => {
        let t = 0;
        const bucket = new RateLimiter(3, () => t);
        expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
        t += 334;
        expect(bucket.take()).toBe(true);
        expect(bucket.take()).toBe(false);
    });
});
