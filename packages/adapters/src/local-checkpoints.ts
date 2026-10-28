import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { existingLocalDatabase } from './local-database.js';
import { registerLocalPayload, assertLocalPayload } from './retention-schema.js';
import { projectCheckpoint, parseCheckpointEvidence } from '../../core/src/usage.js';
import { AppError } from '../../contracts/src/model.js';
import type { ArtifactFile, Checkpoint, CheckpointStore, Clock } from '../../contracts/src/model.js';
import { record } from '../../contracts/src/inputs.js';
import { checkArtifacts } from '../../core/src/artifacts.js';
import { privateDirectory, readRegular, safeFile, writeExclusive } from './safe-files.js';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maximumBytes = 16000000;
/** Checkpoints are private envelopes, physically separate from public manifests. */
export async function createCheckpointStore(directory: string, clock: Clock): Promise<CheckpointStore> {
    const root = await privateDirectory(directory);
    const store: CheckpointStore = {
        async evidence(id) {
            const db = await existingLocalDatabase(dirname(root)), row = db?.sql.prepare('select data from checkpoint_evidence where id=?').get(id);
            if (row)
                return parseCheckpointEvidence(JSON.parse(String(row.data)));
            const loaded = await store.load(id);
            return projectCheckpoint(loaded.checkpoint, loaded.state, loaded.files, null).evidence;
        },
        async save(job, lease, state, files) {
            if (lease.jobId !== job.id || lease.expiresAt <= clock.now())
                throw new AppError('STALE_LEASE', 'Cannot save an expired or foreign lease.');
            checkArtifacts(files);
            const id = randomUUID();
            const checkpoint: Checkpoint = { id, jobId: job.id, stage: job.stage,
                manifestId: typeof state.manifestId === 'string' ? state.manifestId : null, stateKey: id + '.json', createdAt: clock.now() };
            const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, checkpoint, state, files: files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes).toString('base64') })) }));
            if (bytes.length > maximumBytes)
                throw new AppError('INVALID_INPUT', 'Checkpoint exceeds its size limit.');
            const db = await existingLocalDatabase(dirname(root)), payload = { accepted: false, kind: 'checkpoint' as const, id, siteId: job.siteId, producer: { jobId: job.id, workerId: lease.workerId, generation: lease.generation }, objects: [{ key: checkpoint.stateKey, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/json' }], createdAt: checkpoint.createdAt, protectUntil: clock.now() + 600000, state: 'staging' as const, firstOrphanAt: null, claimToken: null };
            if (db)
                db.transaction(() => registerLocalPayload(db.sql, payload));
            // Immutable ID: the queue can only point at this envelope after its complete write and fsync.
            await writeExclusive(await safeFile(root, checkpoint.stateKey), bytes);
            if (db)
                db.transaction(() => registerLocalPayload(db.sql, { ...payload, state: 'available' }));
            return checkpoint;
        },
        async load(id) {
            if (!idPattern.test(id))
                throw new AppError('INVALID_INPUT', 'Invalid checkpoint ID.');
            const db = await existingLocalDatabase(dirname(root)), pin = randomUUID();
            if (db)
                db.transaction(() => { assertLocalPayload(db.sql, { kind: 'checkpoint', id }); db.sql.prepare('insert into payload_pins values(?,?,?,?)').run(pin, 'checkpoint', id, Date.now() + 600000); });
            try {
                const raw = await readRegular(await safeFile(root, id + '.json'), maximumBytes), value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
                const inventoried = db?.sql.prepare("select data from payload_inventory where kind='checkpoint' and id=?").get(id);
                if (inventoried) {
                    const p = JSON.parse(String(inventoried.data));
                    if (p.objects.length !== 1 || p.objects[0].key !== id + '.json' || p.objects[0].size !== raw.length || p.objects[0].sha256 !== createHash('sha256').update(raw).digest('hex'))
                        throw new AppError('INVALID_INPUT', 'Checkpoint physical digest mismatch.');
                }
                if (!record(value) || value.version !== 1 || !record(value.checkpoint) || value.checkpoint.id !== id || value.checkpoint.stateKey !== id + '.json' ||
                    typeof value.checkpoint.jobId !== 'string' || typeof value.checkpoint.stage !== 'string' || !Number.isSafeInteger(value.checkpoint.createdAt) ||
                    (value.checkpoint.manifestId !== null && typeof value.checkpoint.manifestId !== 'string') || !record(value.state) || !Array.isArray(value.files))
                    throw new AppError('INVALID_INPUT', 'Corrupt checkpoint envelope.');
                const files: ArtifactFile[] = value.files.map((file: unknown) => {
                    if (!record(file) || typeof file.path !== 'string' || typeof file.mediaType !== 'string' || typeof file.bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.bytes))
                        throw new AppError('INVALID_INPUT', 'Corrupt checkpoint file.');
                    return { path: file.path, mediaType: file.mediaType, bytes: new Uint8Array(Buffer.from(file.bytes, 'base64')) };
                });
                checkArtifacts(files);
                if (db && !db.sql.prepare("select 1 from payload_inventory where kind='checkpoint' and id=?").get(id)) {
                    if (typeof value.state.siteId !== 'string' || value.state.jobId !== value.checkpoint.jobId)
                        throw new AppError('INVALID_INPUT', 'Checkpoint ownership is unknown.');
                    const c = value.checkpoint, siteId = value.state.siteId, digest = createHash('sha256').update(raw).digest('hex');
                    db.transaction(() => registerLocalPayload(db.sql, { kind: 'checkpoint', id, siteId: String(siteId), producer: { jobId: String(c.jobId), workerId: 'legacy-local', generation: 0 }, objects: [{ key: id + '.json', size: raw.length, sha256: digest, mediaType: 'application/json' }], createdAt: Number(c.createdAt), protectUntil: Date.now() + 600000, state: 'available', firstOrphanAt: null, claimToken: null }));
                }
                return { checkpoint: value.checkpoint as unknown as Checkpoint, state: value.state, files };
            }
            finally {
                if (db)
                    db.transaction(() => db.sql.prepare('delete from payload_pins where id=?').run(pin));
            }
        },
    };
    return store;
}
