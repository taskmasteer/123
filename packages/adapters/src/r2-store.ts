import { createHash, randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '../../contracts/src/model.js';
import type { ArtifactFile, ArtifactStore, CheckpointStore, Checkpoint, Job, Lease, Manifest } from '../../contracts/src/model.js';
import { checkArtifacts, artifactLimits, artifactPath, artifactMediaType } from '../../core/src/artifacts.js';
import { object, string, integer, leaseDto, uuid } from '../../contracts/src/http.js';
import { SupabaseRepository } from './supabase-repository.js';
import type { LeaseAuthority, SqlTransaction } from './supabase-repository.js';
import { registerPostgresPayload, assertPostgresPayload } from './postgres-retention.js';
import { projectCheckpoint, parseCheckpointEvidence } from '../../core/src/usage.js';
import { verifyValidationPng } from './import-resources.js';
export interface ObjectTransport {
    range?(key: string, offset: number, length: number, signal?:AbortSignal): Promise<Uint8Array>;
    delete?(key: string, signal?:AbortSignal): Promise<void>;
    signPut(key: string, mediaType: string): Promise<string>;
    put(key: string, bytes: Uint8Array, mediaType: string, signal?:AbortSignal): Promise<void>;
    head(key: string, signal?:AbortSignal): Promise<{
        size: number;
        mediaType: string;
    }>;
    get(key: string, maxBytes: number, signal?:AbortSignal): Promise<Uint8Array>;
}
export class R2Transport implements ObjectTransport {
    constructor(private client: S3Client, private bucket: string) { }
    async delete(key: string, signal?:AbortSignal) { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),signal?{abortSignal:signal}:{}); }
    async range(key: string, offset: number, length: number, signal?:AbortSignal) {
        if (length < 1 || length > 1024 ** 2)
            throw new AppError('INVALID_INPUT', 'Неверный диапазон.');
        const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${offset}-${offset + length - 1}` }),signal?{abortSignal:signal}:{});
        if (!response.Body || response.ContentLength !== length)
            throw new AppError('INVALID_INPUT', 'Диапазон объекта повреждён.');
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of response.Body as AsyncIterable<Uint8Array>) {
            signal?.throwIfAborted();
            size += part.length;
            if (size > length)
                throw new AppError('INVALID_INPUT', 'Диапазон превышен.');
            parts.push(part);
        }
        if (size !== length)
            throw new AppError('INVALID_INPUT', 'Диапазон усечён.');
        return Buffer.concat(parts);
    }
    signPut(key: string, mediaType: string) { return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mediaType, IfNoneMatch: '*' }), { expiresIn: 600, signableHeaders: new Set(['content-type', 'if-none-match']) }); }
    async put(key: string, bytes: Uint8Array, mediaType: string, signal?:AbortSignal) { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mediaType, IfNoneMatch: '*' }),signal?{abortSignal:signal}:{}); }
    async head(key: string, signal?:AbortSignal) { const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), signal?{abortSignal:signal}:{}); return { size: r.ContentLength ?? -1, mediaType: r.ContentType ?? '' }; }
    async get(key: string, maxBytes: number, signal?:AbortSignal) {
        const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }),signal?{abortSignal:signal}:{});
        if (!r.Body || (r.ContentLength ?? Infinity) > maxBytes)
            throw new AppError('INVALID_INPUT', 'Размер объекта не соответствует снимку.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const part of r.Body as AsyncIterable<Uint8Array>) {
            signal?.throwIfAborted();
            size += part.length;
            if (size > maxBytes)
                throw new AppError('INVALID_INPUT', 'Размер объекта превышен.');
            chunks.push(part);
        }
        return Buffer.concat(chunks);
    }
}
export type FileMetadata = Omit<Manifest['files'][number], 'objectKey'>;
interface Prepared {
    manifest: Manifest;
    checkpoint: Checkpoint | null;
    state: Manifest['files'][number] | null;
    expectedCheckpointId: string | null;
}
export interface PrepareInput {
    lease: Lease;
    purpose: 'artifact' | 'checkpoint' | 'validation';
    templateVersion: string;
    files: FileMetadata[];
    expectedCheckpointId: string | null;
    stage?: string;
    state?: FileMetadata;
}
const hash = (bytes: Uint8Array, kind: 'sha256' | 'sha1') => createHash(kind).update(bytes).digest('hex');
export const metadata = (f: ArtifactFile): FileMetadata => ({ path: f.path, size: f.bytes.length, sha256: hash(f.bytes, 'sha256'), sha1: hash(f.bytes, 'sha1'), mediaType: f.mediaType });
function meta(value: unknown, maximum = artifactLimits.fileBytes as number): FileMetadata {
    const p = object(value, ['path', 'size', 'sha256', 'sha1', 'mediaType']);
    if (typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) || typeof p.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(p.sha1))
        throw new AppError('INVALID_INPUT', 'Некорректный хэш.');
    return { path: string(p.path, 240), size: integer(p.size, 0, maximum), sha256: p.sha256, sha1: p.sha1, mediaType: string(p.mediaType, 100) };
}
export function prepareInput(value: unknown): PrepareInput {
    const p = object(value, ['lease', 'purpose', 'templateVersion', 'files', 'expectedCheckpointId', 'stage', 'state']);
    if (!['artifact', 'checkpoint', 'validation'].includes(String(p.purpose)) || !Array.isArray(p.files))
        throw new AppError('INVALID_INPUT', 'Некорректный снимок.');
    const files = p.files.map(f => meta(f, p.purpose === 'validation' ? 8000000 : artifactLimits.fileBytes));
    if (p.purpose === 'validation' && (files.length !== 1 || files.some(f => !/^validation\/[a-f0-9-]{36}\.png$/.test(f.path) || f.mediaType !== 'image/png')))
        throw new AppError('INVALID_INPUT', 'Неверный снимок проверки.');
    checkArtifacts(files.map(f => ({ path: f.path, mediaType: f.mediaType, bytes: new Uint8Array() })));
    if (files.reduce((n, f) => n + f.size, 0) > artifactLimits.totalBytes)
        throw new AppError('INVALID_INPUT', 'Снимок слишком большой.');
    const result: PrepareInput = { lease: leaseDto(p.lease), purpose: p.purpose as PrepareInput['purpose'], templateVersion: string(p.templateVersion, 100), files, expectedCheckpointId: p.expectedCheckpointId === null ? null : uuid(p.expectedCheckpointId) };
    if (result.purpose === 'checkpoint') {
        result.stage = string(p.stage, 100);
        result.state = meta(p.state);
        if (result.state.path !== 'state.json' || result.state.mediaType !== 'application/json')
            throw new AppError('INVALID_INPUT', 'Некорректное состояние.');
    }
    else if (p.state !== undefined || p.stage !== undefined)
        throw new AppError('INVALID_INPUT', 'Приватное состояние запрещено в артефакте.');
    return result;
}
export class R2Store implements ArtifactStore, CheckpointStore {
    constructor(readonly repository: SupabaseRepository, readonly transport: ObjectTransport, readonly authority?: LeaseAuthority) { }
    async evidence(id: string) {
        const row = (await this.repository.pool.query('select data from private.checkpoint_evidence where id=$1', [id])).rows[0];
        if (row)
            return parseCheckpointEvidence(row.data);
        const loaded = await this.load(id);
        return projectCheckpoint(loaded.checkpoint, loaded.state, loaded.files, null).evidence;
    }
    async pin<T>(kind: 'artifact' | 'checkpoint' | 'screenshot', id: string, action: () => Promise<T>): Promise<T> {
        const token = randomUUID();
        await this.repository.transaction(async (tx) => { await assertPostgresPayload(tx, { kind, id }); await tx.query("insert into private.payload_pins values($1,$2,$3,clock_timestamp()+interval '10 minutes')", [token, kind, id]); });
        try {
            return await action();
        }
        finally {
            await this.repository.transaction(tx => tx.query('delete from private.payload_pins where id=$1', [token]));
        }
    }
    async readValidation(siteId: string, checkpointId: string, id: string) {
        return this.pin('screenshot', id, async () => {
            const evidence = await this.evidence(checkpointId);
            if (evidence.state.siteId !== siteId || !Array.isArray((evidence.state.validation as any)?.screenshotIds) || !(evidence.state.validation as any).screenshotIds.includes(id))
                throw new AppError('NOT_FOUND', 'Снимок проверки не относится к версии.');
            const row = (await this.repository.pool.query("select data from private.payload_inventory where kind='screenshot' and id=$1 and site_id=$2 and state='available' and data#>>'{producer,jobId}'=$3", [id, siteId, evidence.checkpoint.jobId])).rows[0];
            if (!row || row.data.objects.length !== 1)
                throw new AppError('NOT_FOUND', 'Снимок проверки недоступен.');
            const file = row.data.objects[0], bytes = await this.transport.get(file.key, file.size);
            if (bytes.length !== file.size || hash(bytes, 'sha256') !== file.sha256)
                throw new AppError('INVALID_INPUT', 'Снимок проверки повреждён.');
            return { path: id, bytes, mediaType: 'image/png' };
        });
    }
    async readPinnedTemplate(styleId: string, version: string): Promise<ArtifactFile[] | null> {
        if (!/^[a-z][a-z-]+$/.test(styleId) || !/^\d+(?:\.\d+\.\d+)?$/.test(version))
            throw new AppError('INVALID_INPUT', 'Неверная версия шаблона.');
        const bundles = (await this.repository.pool.query("select s.data from private.recovery_state s where s.key='catalog' or (s.key like 'catalog:%' and exists(select 1 from private.payload_inventory p where p.kind='catalog' and p.id='restore-'||split_part(s.key,':',2) and p.state='available')) order by s.key")).rows.map(r => r.data).filter(b => Array.isArray(b.versions) && b.versions.includes(styleId + '@' + version));
        if (!bundles.length)
            return null;
        const fingerprint = (bundle: any) => JSON.stringify(bundle.files.filter((f: any) => f.path.startsWith('templates/' + styleId + '/')).map((f: any) => [f.path, f.size, f.sha256]).sort((a: any, b: any) => a[0].localeCompare(b[0])));
        if (bundles.some(b => fingerprint(b) !== fingerprint(bundles[0])))
            throw new AppError('NEEDS_ATTENTION', 'Одна версия шаблона имеет разные закреплённые байты.');
        const bundle = bundles[0], index = bundle.files.find((f: any) => f.path === 'templates/catalog.json');
        if (!index || index.size > 200000)
            throw new AppError('INVALID_INPUT', 'Опись шаблона отсутствует.');
        const indexBytes = await this.transport.get(index.key, index.size);
        if (hash(indexBytes, 'sha256') !== index.sha256)
            throw new AppError('INVALID_INPUT', 'Опись шаблона повреждена.');
        const styles = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(indexBytes)), style = Array.isArray(styles) ? styles.find(s => s.id === styleId && s.version === version) : null;
        if (!style || !Array.isArray(style.files) || style.files.length > 100)
            throw new AppError('NOT_FOUND', 'Закреплённая версия не найдена.');
        const result: ArtifactFile[] = [];
        for (const path of style.files) {
            artifactPath(path);
            const f = bundle.files.find((f: any) => f.path === 'templates/' + styleId + '/' + path);
            if (!f || f.size > artifactLimits.fileBytes)
                throw new AppError('INVALID_INPUT', 'Файл шаблона отсутствует.');
            const bytes = await this.transport.get(f.key, f.size);
            if (bytes.length !== f.size || hash(bytes, 'sha256') !== f.sha256)
                throw new AppError('INVALID_INPUT', 'Шаблон повреждён.');
            result.push({ path, bytes, mediaType: artifactMediaType(path) });
        }
        checkArtifacts(result);
        return result;
    }
    private async authorized(tx: SqlTransaction, workerId: string, lease: Lease) {
        if (!this.authority)
            throw new AppError('UNAVAILABLE', 'Управление арендой не подключено.');
        const bound = await this.authority.assertCurrent(tx, workerId, lease);
        if (workerId !== lease.workerId || bound.jobId !== lease.jobId || bound.generation !== lease.generation)
            throw new AppError('STALE_LEASE', 'Недействительная аренда.');
        return bound;
    }
    async prepare(workerId: string, input: PrepareInput) {
        input = prepareInput(input);
        const id = randomUUID();
        const prepared = await this.repository.transaction(async (tx) => {
            const bound = await this.authorized(tx, workerId, input.lease);
            const job = (await tx.query('select checkpoint_id from private.jobs where id=$1', [bound.jobId])).rows[0];
            if (!job || job.checkpoint_id !== input.expectedCheckpointId)
                throw new AppError('CONFLICT', 'Состояние задания изменилось.');
            const createdAt = Number((await tx.query('select floor(extract(epoch from clock_timestamp())*1000)::text now')).rows[0].now);
            const prefix = input.purpose === 'artifact' ? 'artifacts' : input.purpose === 'validation' ? 'validation' : 'checkpoints';
            const manifest: Manifest = { id, siteId: bound.siteId, templateVersion: input.templateVersion, createdAt, files: input.files.map((f, i) => ({ ...f, objectKey: `private/${prefix}/${bound.siteId}/${id}/files/${i}` })) };
            const state = input.state ? { ...input.state, objectKey: `private/checkpoints/${bound.siteId}/${id}/state` } : null;
            const checkpoint: Checkpoint | null = state ? { id, jobId: bound.jobId, stage: input.stage!, manifestId: null, stateKey: state.objectKey, createdAt } : null;
            const prepared: Prepared = { manifest, checkpoint, state, expectedCheckpointId: input.expectedCheckpointId };
            if (input.purpose === 'validation')
                for (const f of manifest.files)
                    await registerPostgresPayload(tx, { kind: 'screenshot', id: f.path, siteId: bound.siteId, objects: [{ key: f.objectKey, size: f.size, sha256: f.sha256, mediaType: f.mediaType }], producer: { jobId: bound.jobId, workerId, generation: bound.generation }, createdAt, protectUntil: createdAt + 600000, state: 'staging', firstOrphanAt: null, claimToken: null });
            if (input.purpose !== 'validation')
                await registerPostgresPayload(tx, { accepted: false, kind: state ? 'checkpoint' : 'artifact', id, siteId: bound.siteId, objects: [...manifest.files, ...(state ? [state] : [])].map(f => ({ key: f.objectKey, size: f.size, sha256: f.sha256, mediaType: f.mediaType })), createdAt, protectUntil: createdAt + 600000, state: 'staging', firstOrphanAt: null, claimToken: null });
            await tx.query('insert into private.upload_preparations(id,site_id,job_id,worker_id,generation,purpose,expected_checkpoint_id,metadata,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval \'10 minutes\')', [id, bound.siteId, bound.jobId, workerId, bound.generation, input.purpose, input.expectedCheckpointId, prepared]);
            return prepared;
        });
        const files = [...prepared.manifest.files, ...(prepared.state ? [prepared.state] : [])];
        return { uploadId: id, expiresAt: prepared.manifest.createdAt + 600000, files: await Promise.all(files.map(async (f) => ({ path: f.path, objectKey: f.objectKey, url: await this.transport.signPut(f.objectKey, f.mediaType), headers: { 'content-type': f.mediaType, 'if-none-match': '*' } }))) };
    }
    async complete(workerId: string, uploadId: string, lease: Lease) {
        uuid(uploadId);
        const load = async (tx: SqlTransaction) => {
            const bound = await this.authorized(tx, workerId, lease);
            const row = (await tx.query('select *,expires_at>clock_timestamp() fresh from private.upload_preparations where id=$1 for update', [uploadId])).rows[0];
            if (!row || row.worker_id !== workerId || row.job_id !== bound.jobId || row.site_id !== bound.siteId || Number(row.generation) !== bound.generation)
                throw new AppError('NOT_FOUND', 'Загрузка не найдена.');
            if (!row.completed_at && !row.fresh)
                throw new AppError('STALE_LEASE', 'Загрузка истекла.');
            return row;
        };
        const initial = await this.repository.transaction(load), prepared = initial.metadata as Prepared;
        // HEAD is only a size/type check. Actual bytes are verified before metadata is consumable.
        let stateBytes: Uint8Array | undefined;
        for (const f of [...prepared.manifest.files, ...(prepared.state ? [prepared.state] : [])]) {
            const head = await this.transport.head(f.objectKey);
            if (head.size !== f.size || head.mediaType !== f.mediaType)
                throw new AppError('INVALID_INPUT', 'Метаданные объекта не совпадают.');
            const verified = await this.bytes(f);
            if (initial.purpose === 'validation')
                verifyValidationPng(verified);
            if (f === prepared.state)
                stateBytes = verified;
        }
        return this.repository.transaction(async (tx) => {
            const row = await load(tx);
            if (row.completed_at)
                return { uploadId, checkpointId: prepared.checkpoint?.id ?? null, manifestId: prepared.checkpoint || row.purpose === 'validation' ? null : prepared.manifest.id };
            const job = (await tx.query('select checkpoint_id from private.jobs where id=$1', [lease.jobId])).rows[0];
            if (job.checkpoint_id !== row.expected_checkpoint_id)
                throw new AppError('CONFLICT', 'Предыдущая контрольная точка изменилась.');
            if (row.purpose === 'validation') {
                for (const f of prepared.manifest.files)
                    await registerPostgresPayload(tx, { kind: 'screenshot', id: f.path, siteId: row.site_id, objects: [{ key: f.objectKey, size: f.size, sha256: f.sha256, mediaType: f.mediaType }], producer: { jobId: row.job_id, workerId, generation: Number(row.generation) }, createdAt: prepared.manifest.createdAt, protectUntil: prepared.manifest.createdAt + 600000, state: 'available', firstOrphanAt: null, claimToken: null });
            }
            else if (prepared.checkpoint) {
                const state = JSON.parse(Buffer.from(stateBytes!).toString('utf8'));
                if (!state || typeof state !== 'object' || Array.isArray(state) || state.jobId !== lease.jobId || state.siteId !== row.site_id)
                    throw new AppError('INVALID_INPUT', 'Состояние принадлежит другому заданию.');
                prepared.checkpoint.manifestId = typeof state.manifestId === 'string' ? uuid(state.manifestId) : null;
                await tx.query('insert into private.checkpoints values($1,$2,$3,$4,$5,$6,$7,$8)', [uploadId, row.site_id, lease.jobId, workerId, lease.generation, row.expected_checkpoint_id, prepared, prepared.checkpoint.manifestId]);
            }
            else
                await tx.query('insert into private.artifacts values($1,$2,$3,true)', [prepared.manifest.id, row.site_id, prepared.manifest]);
            await tx.query("update private.payload_inventory set state='available' where kind=$1 and id=$2", [prepared.state ? 'checkpoint' : 'artifact', uploadId]);
            await tx.query('update private.upload_preparations set completed_at=clock_timestamp() where id=$1', [uploadId]);
            return { uploadId, checkpointId: prepared.checkpoint?.id ?? null, manifestId: prepared.checkpoint || row.purpose === 'validation' ? null : prepared.manifest.id };
        });
    }
    private async bytes(f: Manifest['files'][number]) {
        const bytes = await this.transport.get(f.objectKey, f.size);
        if (bytes.length !== f.size || hash(bytes, 'sha256') !== f.sha256 || hash(bytes, 'sha1') !== f.sha1)
            throw new AppError('INVALID_INPUT', 'Хэш содержимого не совпадает.');
        return bytes;
    }
    async put(siteId: string, files: ArtifactFile[], templateVersion: string) {
        checkArtifacts(files);
        const id = randomUUID(), manifest: Manifest = { id, siteId, templateVersion, createdAt: Date.now(), files: files.map((f, i) => ({ ...metadata(f), objectKey: `private/artifacts/${siteId}/${id}/${i}` })) };
        const payload = { kind: 'artifact' as const, id, siteId, objects: manifest.files.map(f => ({ key: f.objectKey, size: f.size, sha256: f.sha256, mediaType: f.mediaType })), createdAt: manifest.createdAt, protectUntil: manifest.createdAt + 600000, state: 'staging' as const, firstOrphanAt: null, claimToken: null };
        await this.repository.transaction(tx => registerPostgresPayload(tx, payload));
        for (let i = 0; i < files.length; i++)
            await this.transport.put(manifest.files[i]!.objectKey, files[i]!.bytes, files[i]!.mediaType);
        await this.repository.transaction(async (tx) => { await registerPostgresPayload(tx, { ...payload, state: 'available' }); await tx.query('insert into private.artifacts values($1,$2,$3,true)', [id, siteId, manifest]); });
        return manifest;
    }
    async read(id: string) {
        return this.pin('artifact', id, async () => {
            const row = (await this.repository.pool.query('select manifest from private.artifacts where id=$1 and verified', [id])).rows[0];
            if (!row)
                throw new AppError('NOT_FOUND', 'Снимок не найден.');
            const manifest = row.manifest as Manifest;
            const result = await Promise.all(manifest.files.map(async (f) => {
                if (!f.objectKey.startsWith(`private/artifacts/${manifest.siteId}/${manifest.id}/`))
                    throw new AppError('INVALID_INPUT', 'Приватный объект не является артефактом.');
                return { path: f.path, mediaType: f.mediaType, bytes: await this.bytes(f) };
            }));
            checkArtifacts(result);
            return result;
        });
    }
    async save(job: Job, lease: Lease, state: Record<string, unknown>, files: ArtifactFile[]) {
        const stateFile = { path: 'state.json', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(state)) };
        const input: PrepareInput = { lease, purpose: 'checkpoint', templateVersion: job.generation?.templateVersion ?? 'unknown', files: files.map(metadata), expectedCheckpointId: job.checkpointId, stage: job.stage, state: metadata(stateFile) };
        const prepared = await this.prepare(lease.workerId, input);
        const all = [...files, stateFile];
        for (let i = 0; i < all.length; i++)
            await this.transport.put(prepared.files[i]!.objectKey, all[i]!.bytes, all[i]!.mediaType);
        await this.complete(lease.workerId, prepared.uploadId, lease);
        return (await this.load(prepared.uploadId)).checkpoint;
    }
    async load(id: string) {
        return this.pin('checkpoint', id, async () => {
            const row = (await this.repository.pool.query('select metadata from private.checkpoints where id=$1', [id])).rows[0];
            if (!row)
                throw new AppError('NOT_FOUND', 'Контрольная точка не найдена.');
            const p = row.metadata as Prepared;
            const state = JSON.parse(Buffer.from(await this.bytes(p.state!)).toString('utf8')) as Record<string, unknown>;
            const files = await Promise.all(p.manifest.files.map(async (f) => ({ path: f.path, mediaType: f.mediaType, bytes: await this.bytes(f) })));
            checkArtifacts(files);
            return { checkpoint: p.checkpoint!, state, files };
        });
    }
}
