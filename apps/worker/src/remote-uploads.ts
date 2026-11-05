import { AppError } from '../../../packages/contracts/src/model.js';
import type { ArtifactFile, Lease } from '../../../packages/contracts/src/model.js';
import { object, uuid, integer, string } from '../../../packages/contracts/src/http.js';
import { createHash } from 'node:crypto';
const metadata = (f: ArtifactFile) => ({ path: f.path, size: f.bytes.length, mediaType: f.mediaType, sha256: createHash('sha256').update(f.bytes).digest('hex'), sha1: createHash('sha1').update(f.bytes).digest('hex') });
/** Node resource transport. The worker receives scoped PUT capabilities, never bucket credentials.
 * Task8 wires this to its authenticated queue client; this helper alone does not claim a job. */
export async function uploadResources(options: {
    controlOrigin: string;
    workerToken: string;
    lease: Lease;
    purpose: 'artifact' | 'checkpoint' | 'validation';
    templateVersion: string;
    expectedCheckpointId: string | null;
    files: ArtifactFile[];
    state?: ArtifactFile;
    stage?: string;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Trusted host configuration for an internal object transport; never request input. */
    storageOrigin?: string;
}) {
    const transport = options.fetch ?? fetch, base = new URL(options.controlOrigin);
    if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash)
        throw new AppError('INVALID_INPUT', 'Invalid control origin.');
    const phase = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const timer = setTimeout(() => controller.abort(new AppError('UNAVAILABLE', 'Upload phase timed out; completion may require reconciliation.')), options.timeoutMs ?? 30000);
        let abort!: () => void;
        try {
            signal.throwIfAborted();
            return await Promise.race([work(signal), new Promise<never>((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            })]);
        } finally {
            clearTimeout(timer);
            if (abort) signal.removeEventListener('abort', abort);
        }
    };
    const files = [...options.files, ...(options.state ? [options.state] : [])];
    const call = async (path: string, body: unknown) => phase(async signal => { const response = await transport(base.origin + path, { method: 'POST', headers: { authorization: 'Bearer ' + options.workerToken, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal }); if (!response.ok)
        throw new AppError(response.status === 409 ? 'STALE_LEASE' : 'UNAVAILABLE', 'Upload control request rejected.'); return response.json() as Promise<unknown>; });
    const prepared = object(await call('/uploads/prepare', { lease: options.lease, purpose: options.purpose, templateVersion: options.templateVersion, expectedCheckpointId: options.expectedCheckpointId, files: options.files.map(metadata), ...(options.state ? { state: metadata(options.state), stage: options.stage } : {}) }), ['uploadId', 'expiresAt', 'files']);
    const uploadId = uuid(prepared.uploadId);
    if (integer(prepared.expiresAt) <= Date.now() || !Array.isArray(prepared.files) || prepared.files.length !== files.length)
        throw new AppError('INVALID_INPUT', 'Invalid upload preparation.');
    for (let i = 0; i < files.length; i++) {
        const grant = object(prepared.files[i], ['path', 'objectKey', 'url', 'headers']), file = files[i]!, headers = object(grant.headers, ['content-type', 'if-none-match']), url = new URL(string(grant.url, 16000));
        if (grant.path !== file.path || headers['content-type'] !== file.mediaType || headers['if-none-match'] !== '*' || url.protocol !== 'https:' || !(options.storageOrigin ? url.origin === options.storageOrigin : url.hostname.endsWith('.r2.cloudflarestorage.com')) || url.username || url.password)
            throw new AppError('INVALID_INPUT', 'Invalid storage capability.');
        string(grant.objectKey, 1000);
        const result = await phase(signal => transport(url, { method: 'PUT', headers: { 'content-type': file.mediaType, 'if-none-match': '*' }, body: Buffer.from(file.bytes), redirect: 'error', signal }));
        if (!result.ok)
            throw new AppError('UNAVAILABLE', 'Immutable object upload rejected.');
    }
    const result = object(await call('/uploads/complete', { uploadId, lease: options.lease }), ['uploadId', 'checkpointId', 'manifestId']);
    if (uuid(result.uploadId) !== uploadId)
        throw new AppError('INVALID_INPUT', 'Upload identity mismatch.');
    if (result.checkpointId !== null)
        uuid(result.checkpointId);
    if (result.manifestId !== null)
        uuid(result.manifestId);
    return result;
}
