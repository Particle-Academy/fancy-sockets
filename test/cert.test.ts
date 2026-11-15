/**
 * The hand-encoded DER in src/cert.ts. A serial is random, so an encoding bug
 * that depends on its first bytes fails about one run in 512 (CI on 42fed51:
 * "asn1 encoding routines::illegal padding"). These pin it deterministically.
 */
import { X509Certificate } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// A serial whose first byte is 0x00 and second is below 0x80: the shape that
// produced a non-minimal INTEGER.
vi.mock('node:crypto', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:crypto')>();
    return {
        ...real,
        randomBytes: (n: number) => {
            const b = Buffer.alloc(n, 0x11);
            b[0] = 0x00;
            b[1] = 0x01;
            return b;
        },
    };
});

const { createSelfSignedCert, derInteger } = await import('../src/cert.js');

describe('DER INTEGER', () => {
    it('is minimal: no redundant leading zero, and one only when the high bit is set', () => {
        const hex = (b: Buffer): string => derInteger(b).toString('hex');
        expect(hex(Buffer.from([0x05]))).toBe('020105');
        expect(hex(Buffer.from([0x00, 0x01]))).toBe('020101');
        expect(hex(Buffer.from([0x00, 0x00, 0x7f]))).toBe('02017f');
        expect(hex(Buffer.from([0x80]))).toBe('02020080');
        expect(hex(Buffer.from([0x00, 0x80]))).toBe('02020080');
        expect(hex(Buffer.from([0x00]))).toBe('020100');
        expect(hex(Buffer.from([0x00, 0x00]))).toBe('020100');
    });
});

describe('createSelfSignedCert', () => {
    it('builds a certificate OpenSSL accepts when the random serial starts with a zero byte', () => {
        const { cert } = createSelfSignedCert();
        const x = new X509Certificate(cert);
        expect(x.serialNumber.replace(/^0+/, '')).toBe('1' + '11'.repeat(14));
    });
});
