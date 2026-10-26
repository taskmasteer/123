import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppError } from '../../../packages/contracts/src/model.js';
import type { ArtifactFile, Checkpoint, CheckpointStore, Clock } from '../../../packages/contracts/src/model.js';
import { record } from '../../../packages/contracts/src/inputs.js';
import { checkArtifacts } from '../../../packages/core/src/artifacts.js';
import { privateDirectory, readRegular, safeFile, writeExclusive } from '../../../packages/adapters/src/safe-files.js';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maximumBytes = 16_000_000;
/** Checkpoints are private envelopes, physically separate from public manifests. */
export async function createCheckpointStore(directory: string, clock: Clock): Promise<CheckpointStore> {
  const root = await privateDirectory(directory);
  return {
    async save(job, lease, state, files) {
      if (lease.jobId !== job.id || lease.expiresAt <= clock.now()) throw new AppError('STALE_LEASE', 'Cannot save an expired or foreign lease.');
      checkArtifacts(files);
      const id = randomUUID(); const checkpoint: Checkpoint = { id, jobId: job.id, stage: job.stage,
        manifestId: typeof state.manifestId === 'string' ? state.manifestId : null, stateKey: id + '.json', createdAt: clock.now() };
      const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, checkpoint, state, files: files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes).toString('base64') })) }));
      if (bytes.length > maximumBytes) throw new AppError('INVALID_INPUT', 'Checkpoint exceeds its size limit.');
      // Immutable ID: the queue can only point at this envelope after its complete write and fsync.
      await writeExclusive(await safeFile(root, checkpoint.stateKey), bytes); return checkpoint;
    },
    async load(id) {
      if (!idPattern.test(id)) throw new AppError('INVALID_INPUT', 'Invalid checkpoint ID.');
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegular(await safeFile(root, id + '.json'), maximumBytes)));
      if (!record(value) || value.version !== 1 || !record(value.checkpoint) || value.checkpoint.id !== id || value.checkpoint.stateKey !== id + '.json' ||
          typeof value.checkpoint.jobId !== 'string' || typeof value.checkpoint.stage !== 'string' || !Number.isSafeInteger(value.checkpoint.createdAt) ||
          (value.checkpoint.manifestId !== null && typeof value.checkpoint.manifestId !== 'string') || !record(value.state) || !Array.isArray(value.files)) throw new AppError('INVALID_INPUT', 'Corrupt checkpoint envelope.');
      const files: ArtifactFile[] = value.files.map((file: unknown) => {
        if (!record(file) || typeof file.path !== 'string' || typeof file.mediaType !== 'string' || typeof file.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.bytes)) throw new AppError('INVALID_INPUT', 'Corrupt checkpoint file.');
        return { path: file.path, mediaType: file.mediaType, bytes: new Uint8Array(Buffer.from(file.bytes, 'base64')) };
      });
      checkArtifacts(files); return { checkpoint: value.checkpoint as unknown as Checkpoint, state: value.state, files };
    },
  };
}
