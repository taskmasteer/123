import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { ArtifactFile, ArtifactStore } from '../../../../packages/contracts/src/model.js';
import { artifactPath, checkArtifacts } from '../../../../packages/core/src/artifacts.js';

export interface Preview { url: string; close(): Promise<void> }
export const previewPolicy = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self'", "connect-src 'none'", "worker-src 'none'",
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-ancestors 'none'", "sandbox allow-scripts allow-same-origin",
].join('; ');

/** Read-only snapshot; no filesystem paths or host-control routes are exposed. */
export async function serveFiles(files: ArtifactFile[]): Promise<Preview> {
  checkArtifacts(files);
  const snapshot = new Map(files.map((file) => [file.path, { ...file, bytes: Buffer.from(file.bytes) }]));
  const token = randomBytes(32).toString('hex'); const prefix = '/' + token + '/'; const cookieName = 'sf_preview_' + token.slice(0, 16);
  let origin = '';
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', previewPolicy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-DNS-Prefetch-Control', 'off');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    const fail = (status: number) => { response.statusCode = status; response.end(); };
    if (request.headers.host !== new URL(origin).host) return fail(404);
    if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405);
    const raw = request.url ?? '';
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20]|%(?:2e|2f|5c|25|00)/i.test(raw.split('?')[0]!)) return fail(404);
    const pathname = raw.split('?')[0]!;
    const hasCapability = pathname.startsWith(prefix);
    const authenticated = request.headers.cookie?.split(';').some((part) => part.trim() === cookieName + '=' + token);
    if (!hasCapability && !authenticated) return fail(404);
    let path = hasCapability ? pathname.slice(prefix.length) : pathname.slice(1);
    try { path = decodeURIComponent(path); } catch { return fail(404); }
    if (!path || path.endsWith('/')) path += 'index.html';
    try { artifactPath(path); } catch { return fail(404); }
    const file = snapshot.get(path); if (!file) return fail(404);
    if (hasCapability) response.setHeader('Set-Cookie', cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Strict');
    response.setHeader('Content-Type', file.mediaType + (/^(text\/|image\/svg)/.test(file.mediaType) ? '; charset=utf-8' : ''));
    response.setHeader('Content-Length', file.bytes.length);
    response.statusCode = 200; response.end(request.method === 'HEAD' ? undefined : file.bytes);
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = 5_000; server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Preview did not bind a loopback port.'); }
  origin = 'http://127.0.0.1:' + address.port;
  let closing: Promise<void> | undefined;
  return {
    url: origin + prefix,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
      });
      return closing;
    },
  };
}
export function createPreviewServer(store: ArtifactStore): (manifestId: string) => Promise<Preview> {
  return async function startPreview(manifestId: string) { return serveFiles(await store.read(manifestId)); };
}
