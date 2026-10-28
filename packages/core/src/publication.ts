import { createHash } from 'node:crypto';
import type { Manifest, ArtifactFile } from '../../contracts/src/model.js';
import { checkArtifacts } from './artifacts.js';
export const publicationHeaders = {
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
};
export const publisherPolicyVersion = 'static-headers-v1';
export const publisherConfiguration: ArtifactFile = { path: 'vercel.json', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify({ headers: [{ source: '/(.*)', headers: Object.entries(publicationHeaders).map(([key, value]) => ({ key, value })) }] })) };
export const digest = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
/** Stable v1 encoding excludes private storage keys and timestamps. */
export function manifestHash(manifest: Manifest) {
    checkArtifacts(manifest.files.map(f => ({ path: f.path, mediaType: f.mediaType, bytes: new Uint8Array() })));
    if (!manifest.files.some(f => f.path === 'index.html'))
        throw new Error('Publication requires index.html.');
    return digest(Buffer.from(JSON.stringify(['manifest-v1', manifest.files.map(f => [f.path, f.size, f.mediaType, f.sha256, f.sha1]).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1)])));
}
export function deploymentFiles(manifest: Manifest) {
    manifestHash(manifest);
    return [...manifest.files.map(f => ({ file: f.path, sha: f.sha1, size: f.size })), { file: publisherConfiguration.path, sha: digest(publisherConfiguration.bytes, 'sha1'), size: publisherConfiguration.bytes.length }];
}
