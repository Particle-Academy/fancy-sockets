/**
 * A self-signed certificate for wss in CI and local tests, built with
 * node:crypto alone. Node can make keys and sign bytes but has no certificate
 * builder, so the X.509 structure is encoded here as DER by hand. It is
 * deliberately minimal: P-256 ECDSA, SHA-256, a subjectAltName, and nothing a
 * test does not need. NOT for production; a real certificate comes from a CA.
 */
import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIP } from 'node:net';

function len(n: number): Buffer {
    if (n < 0x80) {
        return Buffer.from([n]);
    }
    const bytes: number[] = [];
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
    const body = Buffer.concat(content);
    return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...c: Buffer[]): Buffer => tlv(0x30, ...c);
const set = (...c: Buffer[]): Buffer => tlv(0x31, ...c);

function oid(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number);
    const out: number[] = [40 * parts[0]! + parts[1]!];
    for (const part of parts.slice(2)) {
        const stack: number[] = [part & 0x7f];
        let v = part >> 7;
        while (v > 0) {
            stack.unshift((v & 0x7f) | 0x80);
            v >>= 7;
        }
        out.push(...stack);
    }
    return tlv(0x06, Buffer.from(out));
}

function integer(bytes: Buffer): Buffer {
    // Positive: a leading 0x00 when the high bit is set.
    return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function utcTime(d: Date): Buffer {
    const p = (n: number): string => String(n).padStart(2, '0');
    const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    return tlv(0x17, Buffer.from(s, 'ascii'));
}

function ipBytes(ip: string): Buffer {
    if (isIP(ip) === 4) {
        return Buffer.from(ip.split('.').map(Number));
    }
    // IPv6: expand `::`.
    const [head, tail] = ip.split('::') as [string, string | undefined];
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    return Buffer.concat(groups.map((g) => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(parseInt(g, 16));
        return b;
    }));
}

export interface SelfSignedCert {
    /** PEM certificate; also what a client passes as `ca` to trust it. */
    cert: string;
    /** PEM PKCS#8 private key. */
    key: string;
}

/**
 * @param hosts names and IPs the certificate is valid for. Default `localhost`, `127.0.0.1`, `::1`.
 * @param days validity. Default 7.
 */
export function createSelfSignedCert(options: { hosts?: string[]; days?: number; commonName?: string } = {}): SelfSignedCert {
    const hosts = options.hosts ?? ['localhost', '127.0.0.1', '::1'];
    const days = options.days ?? 7;
    const cn = options.commonName ?? hosts[0] ?? 'localhost';
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
    const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
    const now = Date.now();
    const validity = seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + days * 86_400_000)));
    const spki = publicKey.export({ type: 'spki', format: 'der' });

    const san = seq(...hosts.map((h) => (isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, 'ascii')))));
    const extensions = tlv(
        0xa3,
        seq(
            // basicConstraints: not a CA.
            seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())),
            // keyUsage: digitalSignature (critical).
            seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x03, Buffer.from([0x07, 0x80])))),
            // extKeyUsage: serverAuth.
            seq(oid('2.5.29.37'), tlv(0x04, seq(oid('1.3.6.1.5.5.7.3.1')))),
            // subjectAltName.
            seq(oid('2.5.29.17'), tlv(0x04, san)),
        ),
    );

    const serial = randomBytes(16);
    serial[0]! &= 0x7f;
    const tbs = seq(
        tlv(0xa0, integer(Buffer.from([2]))), // v3
        integer(serial),
        ecdsaSha256,
        name,
        validity,
        name,
        spki,
        extensions,
    );
    const signature = sign('sha256', tbs, privateKey);
    const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

    const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n');
    const cert = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
    // Round-trip through Node's own parser: a malformed structure fails here, not in a client.
    new X509Certificate(cert);
    const key = createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })).export({ type: 'pkcs8', format: 'pem' }) as string;
    return { cert, key };
}
