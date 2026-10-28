import { Resolver } from 'node:dns/promises';
import { Agent, request, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { isPublicAddress } from './public-address.js';
export interface HttpsExpectation {
    hostname: string;
    path: string;
    sha256: string;
    size: number;
    mediaType: string;
    headers: Record<string, string>;
}
export interface HttpsDependencies {
    resolver?: () => Pick<Resolver, 'resolve4' | 'resolve6' | 'cancel'>;
    request?: typeof request;
}
const failure = () => new Error('Public HTTPS evidence could not be verified.');
function destination(hostname: string, path: string) {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) || isIP(hostname) ||
        path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\x00-\x20\\#]/.test(path))
        throw failure();
    const url = new URL(path, `https://${hostname}`);
    if (url.hostname !== hostname || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash)
        throw failure();
    return url;
}
async function addresses(hostname: string, signal: AbortSignal, deps: HttpsDependencies) {
    const resolver = deps.resolver?.() ?? new Resolver({ timeout: 1500, tries: 1 });
    const cancel = () => resolver.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 1500);
    try {
        const found = await Promise.all([resolver.resolve4(hostname), resolver.resolve6(hostname)].map(p => p.catch(error => {
            if (error?.code === 'ENODATA')
                return [];
            throw error;
        })));
        signal.throwIfAborted();
        const result = found.flat();
        if (!result.length || result.length > 64 || result.some(a => !isPublicAddress(a)))
            throw failure();
        return [...new Set(result)];
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        resolver.cancel();
    }
}
/** Server-only. No user URL, credential, connector, proxy or trust override is accepted.
 * One total deadline includes DNS, TLS, redirects and body. Each hop resolves anew but
 * the socket can use only its selected validated address. Never uses ambient fetch. */
export async function verifyPublicHttps(expected: HttpsExpectation, dependencies: HttpsDependencies = {}): Promise<{
    verifiedAt: number;
}> {
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > 4000000 || !/^[a-f0-9]{64}$/.test(expected.sha256))
        throw failure();
    let url = destination(expected.hostname, expected.path);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(failure()), 10000);
    const seen = new Set<string>();
    try {
        for (let redirects = 0; redirects <= 2; redirects++) {
            if (seen.has(url.href))
                throw failure();
            seen.add(url.href);
            const resolved = await addresses(url.hostname, controller.signal, dependencies);
            // One pinned address per hop; a caller may resume the entire bounded observation.
            const address = resolved[0]!, family = isIP(address) as 4 | 6;
            const response = await new Promise<{
                location?: string;
            }>((resolve, reject) => {
                const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, proxyEnv: {} });
                let res: IncomingMessage | undefined, finished = false, connected = false;
                const finish = (error?: unknown, location?: string) => {
                    if (finished)
                        return;
                    finished = true;
                    clearTimeout(headersTimer);
                    controller.signal.removeEventListener('abort', abort);
                    res?.destroy();
                    req.destroy();
                    agent.destroy();
                    error ? reject(error) : resolve(location ? { location } : {});
                };
                const options: RequestOptions = { hostname: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search,
                    method: 'GET', agent, family, rejectUnauthorized: true, maxHeaderSize: 16384, headers: { 'accept-encoding': 'identity' },
                    lookup: (_hostname, opts, callback) => { if (typeof opts === 'object' && opts.all)
                        callback(null, [{ address, family }]);
                    else
                        callback(null, address, family); } };
                const req = (dependencies.request ?? request)(options, incoming => {
                    res = incoming;
                    clearTimeout(headersTimer);
                    if (!connected)
                        return finish(failure());
                    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
                        const location = res.headers.location;
                        if (!location || location.length > 2048)
                            return finish(failure());
                        return finish(undefined, location);
                    }
                    if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
                        res.headers['content-type']?.split(';')[0]?.trim() !== expected.mediaType ||
                        (res.headers['content-length'] !== undefined && res.headers['content-length'] !== String(expected.size)) ||
                        Object.entries(expected.headers).some(([key, value]) => res!.headers[key.toLowerCase()] !== value))
                        return finish(failure());
                    let size = 0;
                    const digest = createHash('sha256');
                    res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > expected.size || size > 4000000)
                        finish(failure());
                    else
                        digest.update(chunk); });
                    res.on('error', finish);
                    res.on('aborted', () => finish(failure()));
                    res.on('end', () => finish(res!.complete && size === expected.size && digest.digest('hex') === expected.sha256 ? undefined : failure()));
                    res.on('close', () => { if (!finished)
                        finish(failure()); });
                });
                const headersTimer = setTimeout(() => finish(failure()), 3000), abort = () => finish(failure());
                controller.signal.addEventListener('abort', abort, { once: true });
                req.on('error', finish);
                req.on('socket', socket => socket.once('secureConnect', () => {
                    // Compare canonical addresses including IPv6 compression without allowing mapped IPv4.
                    const observed = socket.remoteAddress;
                    connected = !!observed && isIP(observed) === family && new URL(`https://${family === 6 ? '[' + observed + ']' : observed}`).hostname === new URL(`https://${family === 6 ? '[' + address + ']' : address}`).hostname;
                    if (!connected)
                        finish(failure());
                }));
                if (controller.signal.aborted)
                    abort();
                else
                    req.end();
            });
            if (!response.location)
                return { verifiedAt: Date.now() };
            if (redirects === 2)
                throw failure();
            const next = new URL(response.location, url);
            if (next.hostname !== expected.hostname || next.protocol !== 'https:' || next.port || next.username || next.password || next.hash)
                throw failure();
            url = destination(expected.hostname, next.pathname + next.search);
        }
        throw failure();
    }
    finally {
        clearTimeout(timer);
        controller.abort();
    }
}
