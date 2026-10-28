import { digest } from '../../../core/src/publication.js';
import type { ArtifactFile } from '../../../contracts/src/model.js';
import type { VercelClient } from './client.js';
export async function uploadFile(client: VercelClient, file: ArtifactFile, sha1: string, size: number) {
    if (file.bytes.length !== size || digest(file.bytes, 'sha1') !== sha1)
        throw new Error('Upload digest mismatch.');
    await client.call('POST', '/v2/files', file.bytes, { 'x-vercel-digest': sha1, 'content-length': String(size) });
}
