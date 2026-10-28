import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress } from '../src/public-address.js';
import { verifyPublicHttps, type HttpsDependencies } from '../src/public-https.js';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
describe('public HTTPS address admission', () => {
    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('admits public unicast %s', address => {
        expect(isPublicAddress(address)).toBe(true);
    });
    it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.255.255',
        '192.0.0.9', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.2', '192.168.1.1',
        '192.175.48.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
        '::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '100::1', '2001::1', '2001:db8::1',
        '2002:808:808::1', '2620:4f:8000::1', '3fff::1', '5f00::1', 'fc00::1', 'fe80::1', 'ff00::1',
        'fe80::1%eth0', '127.1', '0177.0.0.1', 'not-an-ip'])('rejects special or ambiguous address %s', address => {
        expect(isPublicAddress(address)).toBe(false);
    });
});
function fixture(addresses = ['8.8.8.8'], response: {
    status?: number;
    headers?: Record<string, string>;
    chunks?: Buffer[];
    remote?: string;
    complete?: boolean;
} = {}) {
    const options: RequestOptions[] = [];
    let cancellations = 0, destroyed = 0;
    const dependencies: HttpsDependencies = {
        resolver: () => ({ resolve4: async () => addresses, resolve6: async () => [], cancel: () => { cancellations++; } }) as unknown as ReturnType<NonNullable<HttpsDependencies['resolver']>>,
        request: ((opts: RequestOptions, callback: (r: unknown) => void) => {
            options.push(opts);
            const req = new EventEmitter() as EventEmitter & {
                end: () => void;
                destroy: () => void;
            };
            req.destroy = () => { destroyed++; };
            req.end = () => queueMicrotask(() => {
                const socket = Object.assign(new EventEmitter(), { remoteAddress: response.remote ?? addresses[0] });
                req.emit('socket', socket);
                socket.emit('secureConnect');
                const res = Object.assign(new PassThrough(), { statusCode: response.status ?? 200, headers: { 'content-type': 'text/html', ...response.headers }, complete: response.complete ?? true });
                callback(res);
                for (const chunk of response.chunks ?? [Buffer.from('hello')])
                    res.write(chunk);
                res.end();
            });
            return req;
        }) as NonNullable<HttpsDependencies['request']>,
    };
    return { dependencies, options, counts: () => ({ cancellations, destroyed }) };
}
const expected = { hostname: 'example.com', path: '/index.html', size: 5, sha256: createHash('sha256').update('hello').digest('hex'), mediaType: 'text/html', headers: {} };
it('pins public DNS and keeps original TLS hostname with isolated proxy-free agent', async () => {
    const f = fixture();
    await expect(verifyPublicHttps(expected, f.dependencies)).resolves.toHaveProperty('verifiedAt');
    expect(f.options).toHaveLength(1);
    expect(f.options[0]).toMatchObject({ hostname: 'example.com', servername: 'example.com', port: 443, rejectUnauthorized: true, family: 4, headers: { 'accept-encoding': 'identity' } });
    const lookup = f.options[0]!.lookup!;
    await new Promise<void>((resolve, reject) => lookup('example.com', { all: false }, (error, address, family) => { try {
        expect(error).toBeNull();
        expect(address).toBe('8.8.8.8');
        expect(family).toBe(4);
        resolve();
    }
    catch (e) {
        reject(e);
    } }));
});
it('rejects mixed DNS before any socket is opened', async () => {
    const f = fixture(['8.8.8.8', '127.0.0.1']);
    await expect(verifyPublicHttps(expected, f.dependencies)).rejects.toThrow();
    expect(f.options).toHaveLength(0);
});
it.each([
    { remote: '127.0.0.1' }, { chunks: [Buffer.from('wrong')] }, { chunks: [Buffer.from('hello!')] }, { chunks: [Buffer.from('hell')] },
    { complete: false }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': '4' } }, { headers: { 'content-type': 'image/svg+xml' } },
    { status: 302, headers: { location: 'http://example.com/index.html' } }, { status: 302, headers: { location: 'https://other.com/index.html' } },
    { status: 302, headers: { location: '/index.html' } },
])('rejects unsafe or incorrect HTTPS response %#', async (response) => {
    await expect(verifyPublicHttps(expected, fixture(undefined, response).dependencies)).rejects.toThrow();
});
it('requires enforced response headers', async () => {
    await expect(verifyPublicHttps({ ...expected, headers: { 'content-security-policy': "default-src 'none'" } }, fixture().dependencies)).rejects.toThrow();
});
it.each([{ addresses: [] }, { addresses: Array.from({ length: 65 }, () => '8.8.8.8') }, { addresses: ['malformed'] }])('rejects empty, oversized or malformed DNS answers %#', async ({ addresses }) => {
    const f = fixture(addresses);
    await expect(verifyPublicHttps(expected, f.dependencies)).rejects.toThrow();
    expect(f.options).toHaveLength(0);
});
it('revalidates a same-host redirect and rejects rebinding before a second socket', async () => {
    const f = fixture(undefined, { status: 302, headers: { location: '/next.html' } });
    let calls = 0;
    f.dependencies.resolver = () => ({ resolve4: async () => ++calls === 1 ? ['8.8.8.8'] : ['127.0.0.1'], resolve6: async () => [], cancel() { } }) as any;
    await expect(verifyPublicHttps(expected, f.dependencies)).rejects.toThrow();
    expect(f.options).toHaveLength(1);
});
it('allows an absent DNS family only as ENODATA and still verifies an IPv6-only endpoint', async () => {
    const f = fixture(['2606:4700:4700::1111']);
    f.dependencies.resolver = () => ({ resolve4: async () => { throw Object.assign(new Error('absent'), { code: 'ENODATA' }); }, resolve6: async () => ['2606:4700:4700::1111'], cancel() { } }) as any;
    await expect(verifyPublicHttps(expected, f.dependencies)).resolves.toHaveProperty('verifiedAt');
    expect(f.options[0]!.family).toBe(6);
    f.dependencies.resolver = () => ({ resolve4: async () => { throw Object.assign(new Error('failure'), { code: 'SERVFAIL' }); }, resolve6: async () => ['2606:4700:4700::1111'], cancel() { } }) as any;
    await expect(verifyPublicHttps(expected, f.dependencies)).rejects.toThrow();
    expect(f.options).toHaveLength(1);
});
it('cancels the actual resolver at its DNS deadline instead of abandoning the lookup', async () => {
    const f = fixture();
    let cancelled = 0;
    const rejectors: ((e: Error) => void)[] = [];
    f.dependencies.resolver = () => ({ resolve4: () => new Promise((_, reject) => rejectors.push(reject)), resolve6: () => new Promise((_, reject) => rejectors.push(reject)), cancel() { cancelled++; rejectors.forEach(reject => reject(new Error('cancelled'))); } }) as any;
    vi.useFakeTimers();
    try {
        const rejected = expect(verifyPublicHttps(expected, f.dependencies)).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(1501);
        await rejected;
        expect(cancelled).toBeGreaterThan(0);
        expect(f.options).toHaveLength(0);
    }
    finally {
        vi.useRealTimers();
    }
});
it('destroys stalled header requests at the bounded deadline and retains normal TLS verification', async () => {
    const f = fixture();
    let destroyed = 0;
    f.dependencies.request = ((options: RequestOptions) => { expect(options.rejectUnauthorized).toBe(true); const req = Object.assign(new EventEmitter(), { end() { }, destroy() { destroyed++; } }); return req; }) as any;
    vi.useFakeTimers();
    try {
        const rejected = expect(verifyPublicHttps(expected, f.dependencies)).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(3001);
        await rejected;
        expect(destroyed).toBe(1);
    }
    finally {
        vi.useRealTimers();
    }
});
