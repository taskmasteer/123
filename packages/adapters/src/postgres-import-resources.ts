import { assertPostgresPayload, registerPostgresPayload } from './postgres-retention.js';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../contracts/src/model.js';
import type { Principal, ArtifactFile } from '../../contracts/src/model.js';
import type { ImportRowView, ImportSummary } from '../../contracts/src/import.js';
import { rowFingerprint, importLimits } from '../../contracts/src/import.js';
import { parseImport, validateRows } from '../../core/src/import/rows.js';
import { object, integer, string, uuid } from '../../contracts/src/http.js';
import type { SqlTransaction } from './supabase-repository.js';
import { PostgresBatches } from './postgres-batches.js';
import { decodeLogo } from './import-resources.js';
interface Resource {
    id: string;
    name: string;
    size: number;
    sha256: string;
    complete: boolean;
    draftId?: string;
    rowNumber?: number;
    revision?: number;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class PostgresImportResources {
    constructor(readonly batches: PostgresBatches) { }
    private async resource(tx: Pick<SqlTransaction, 'query'>, actor: Principal, id: string, lock = false): Promise<Resource> {
        const r = (await tx.query('select * from private.import_resources where id=$1' + (lock ? ' for update' : ''), [id])).rows[0];
        if (!r)
            throw new AppError('NOT_FOUND', 'Ресурс не найден.');
        if (r.owner_id !== actor.userId)
            throw new AppError('FORBIDDEN', 'Чужой ресурс.');
        await assertPostgresPayload(tx, { kind: 'resource', id });
        return r.data;
    }
    private async bytes(r: Resource) {
        await this.batches.repository.transaction(tx => assertPostgresPayload(tx, { kind: 'resource', id: r.id }));
        const parts = (await this.batches.repository.pool.query('select part,bytes from private.import_chunks where resource_id=$1 order by part', [r.id])).rows;
        if (parts.some((p, i) => p.part !== i))
            throw new AppError('INVALID_INPUT', 'Не хватает фрагментов.');
        const bytes = Buffer.concat(parts.map(p => p.bytes));
        if (bytes.length !== r.size || hash(bytes) !== r.sha256)
            throw new AppError('INVALID_INPUT', 'Размер или хеш файла не совпадает.');
        return bytes;
    }
    async request(actor: Principal, method: string, value: unknown): Promise<unknown> {
        const repo = this.batches.repository;
        if (method === 'resource.begin') {
            const p = object(value, ['name', 'size', 'sha256', 'draftId', 'rowNumber', 'revision']), name = string(p.name, 200), logo = p.draftId !== undefined;
            if (!(logo ? /\.png$/i : /\.(csv|xlsx)$/i).test(name) || !/^[a-f0-9]{64}$/.test(String(p.sha256)))
                throw new AppError('INVALID_INPUT', 'Некорректный файл.');
            const id = randomUUID(), r: Resource = { id, name, size: integer(p.size, 1, logo ? 2000000 : importLimits.sourceBytes), sha256: String(p.sha256), complete: false };
            await repo.transaction(async (tx) => {
                actor = await repo.fresh(tx, actor);
                if (logo) {
                    const d = await this.batches.read(tx, actor, uuid(p.draftId), true, true);
                    if (d.summary.state !== 'preview' || d.summary.revision !== integer(p.revision))
                        throw new AppError('CONFLICT', 'Предпросмотр изменился.');
                    Object.assign(r, { draftId: uuid(p.draftId), rowNumber: integer(p.rowNumber, 2, 5001), revision: d.summary.revision });
                    if (!(await tx.query('select 1 from private.batch_rows where batch_id=$1 and row_number=$2', [r.draftId, r.rowNumber])).rowCount)
                        throw new AppError('NOT_FOUND', 'Строка не найдена.');
                }
                await registerPostgresPayload(tx, { kind: 'resource', id, siteId: null, createdAt: Date.now(), protectUntil: Date.now() + 600000, state: 'staging', firstOrphanAt: null, claimToken: null, objects: [{ key: 'database:private.import_chunks:' + id, size: r.size, sha256: r.sha256, mediaType: logo ? 'image/png' : 'application/octet-stream' }] });
                await tx.query('insert into private.import_resources values($1,$2,$3)', [id, actor.userId, r]);
            });
            return { id };
        }
        if (method === 'resource.chunk') {
            const p = object(value, ['id', 'index', 'base64']), id = uuid(p.id), part = integer(p.index, 0, 699), base64 = string(p.base64, 32000), bytes = Buffer.from(base64, 'base64');
            if (bytes.toString('base64') !== base64 || bytes.length > importLimits.chunkBytes)
                throw new AppError('INVALID_INPUT', 'Некорректный фрагмент.');
            await repo.transaction(async (tx) => {
                actor = await repo.fresh(tx, actor);
                const r = await this.resource(tx, actor, id, true);
                if (r.complete)
                    throw new AppError('CONFLICT', 'Ресурс завершён.');
                const old = (await tx.query('select bytes from private.import_chunks where resource_id=$1 and part=$2', [id, part])).rows[0];
                if (old) {
                    if (!old.bytes.equals(bytes))
                        throw new AppError('CONFLICT', 'Фрагмент уже существует.');
                    return;
                }
                if (Number((await tx.query('select coalesce(sum(octet_length(bytes)),0) size from private.import_chunks where resource_id=$1', [id])).rows[0].size) + bytes.length > r.size)
                    throw new AppError('INVALID_INPUT', 'Превышен размер файла.');
                await tx.query('insert into private.import_chunks values($1,$2,$3)', [id, part, bytes]);
            });
            return { ok: true };
        }
        if (method === 'import.prepare') {
            const p = object(value, ['id']), id = uuid(p.id), r = await this.resource(repo.pool, actor, id);
            if (r.draftId)
                throw new AppError('INVALID_INPUT', 'Это логотип.');
            if (r.complete)
                return this.batches.get(actor, id);
            const parsed = await parseImport({ name: r.name, bytes: await this.bytes(r) }), invalid = new Set(parsed.issues.map(i => i.rowNumber)).size;
            await repo.transaction(async (tx) => { actor = await repo.fresh(tx, actor); await this.resource(tx, actor, id, true); const summary: ImportSummary = { id, name: r.name, revision: 1, state: 'uploading', total: parsed.rows.length, validCount: parsed.rows.length - invalid, invalidCount: invalid, canControl: true }; await tx.query("insert into private.batches(id,owner_id,state,data) values($1,$2,'uploading',$3) on conflict(id) do nothing", [id, actor.userId, { summary, hash: r.sha256 }]); });
            for (let offset = 0; offset < parsed.rows.length; offset += 50)
                await repo.transaction(async (tx) => {
                    actor = await repo.fresh(tx, actor);
                    const d = await this.batches.read(tx, actor, id, true, true);
                    if (d.summary.state !== 'uploading')
                        return;
                    for (const input of parsed.rows.slice(offset, offset + 50))
                        await this.batches.putRow(tx, id, { rowNumber: input.rowNumber, input, issues: parsed.issues.filter(i => i.rowNumber === input.rowNumber), siteId: null, job: null });
                });
            await repo.transaction(async (tx) => {
                actor = await repo.fresh(tx, actor);
                const d = await this.batches.read(tx, actor, id, true, true);
                if (d.summary.state === 'uploading') {
                    d.summary.state = 'preview';
                    await this.batches.save(tx, d);
                    r.complete = true;
                    await assertPostgresPayload(tx, { kind: 'resource', id: r.id });
                    await tx.query("update private.payload_inventory set state='available' where kind='resource' and id=$1", [r.id]);
                    await tx.query('update private.import_resources set data=$2 where id=$1', [id, r]);
                }
            });
            return this.batches.get(actor, id);
        }
        if (method === 'import.update' || method === 'logo.complete') {
            const p = object(value, method === 'import.update' ? ['id', 'revision', 'rowNumber', 'domain', 'about', 'referenceId', 'layoutReferenceId', 'mentionedUrl', 'mentionedDescription'] : ['id']);
            let resource: Resource | undefined;
            if (method === 'logo.complete') {
                resource = await this.resource(repo.pool, actor, uuid(p.id));
                if (!resource.draftId)
                    throw new AppError('INVALID_INPUT', 'Это не логотип.');
                decodeLogo(await this.bytes(resource));
            }
            const id = resource?.draftId ?? uuid(p.id);
            await repo.transaction(async (tx) => {
                actor = await repo.fresh(tx, actor);
                const d = await this.batches.read(tx, actor, id, true, true);
                if (resource?.complete)
                    return;
                if (d.summary.state !== 'preview' || d.summary.revision !== (resource?.revision ?? integer(p.revision)))
                    throw new AppError('CONFLICT', 'Предпросмотр изменился.');
                const rows = await this.batches.rows(id, tx), originals = new Map(rows.map(r => [r.rowNumber, rowFingerprint(r)])), row = rows.find(v => v.rowNumber === (resource?.rowNumber ?? integer(p.rowNumber, 2, 5001)));
                if (!row)
                    throw new AppError('NOT_FOUND', 'Строка не найдена.');
                if (resource) {
                    row.input.logoAssetId = resource.id;
                    resource.complete = true;
                    await assertPostgresPayload(tx, { kind: 'resource', id: resource.id });
                    await tx.query("update private.payload_inventory set state='available' where kind='resource' and id=$1", [resource.id]);
                    await tx.query('update private.import_resources set data=$2 where id=$1', [resource.id, resource]);
                }
                else
                    for (const field of ['about', 'domain', 'referenceId', 'layoutReferenceId', 'mentionedUrl', 'mentionedDescription'] as const)
                        if (p[field] !== undefined) {
                            if (typeof p[field] !== 'string' || p[field].length > (field === 'domain' ? 253 : field === 'referenceId' ? 100 : 8000))
                                throw new AppError('INVALID_INPUT', 'Некорректное значение.');
                            row.input[field] = p[field];
                            row.issues = row.issues.filter(i => i.column !== field);
                        }
                const parsed = validateRows(rows.map(r => r.input), rows.flatMap(r => r.issues));
                for (const r of rows) {
                    r.issues = parsed.issues.filter(i => i.rowNumber === r.rowNumber);
                    if (originals.get(r.rowNumber) !== rowFingerprint(r))
                        await this.batches.putRow(tx, id, r);
                }
                d.summary.invalidCount = new Set(parsed.issues.map(i => i.rowNumber)).size;
                d.summary.validCount = rows.length - d.summary.invalidCount;
                d.summary.revision++;
                await this.batches.save(tx, d);
            });
            return this.batches.get(actor, id);
        }
        if (method === 'import.commit') {
            const p = object(value, ['id', 'revision', 'requestKey']), id = uuid(p.id), revision = integer(p.revision), key = string(p.requestKey, 100);
            await repo.transaction(async (tx) => {
                actor = await repo.fresh(tx, actor);
                const d = await this.batches.read(tx, actor, id, true, true), frozen = hash(Buffer.from(JSON.stringify((await this.batches.rows(id, tx)).map(r => [r.rowNumber, r.input.domain, r.input.about ?? '', r.input.referenceId ?? '', r.input.layoutReferenceId ?? '', r.input.logo ?? '', r.input.logoAssetId ?? '', r.input.mentionedUrl ?? '', r.input.mentionedDescription ?? '']))));
                const old = (await tx.query('select id,payload_hash from private.batches where owner_id=$1 and request_key=$2', [actor.userId, key])).rows[0];
                if (old) {
                    if (old.id !== id || old.payload_hash !== frozen || d.committedRevision !== revision)
                        throw new AppError('CONFLICT', 'Ключ запроса уже использован.');
                    return;
                }
                if (d.summary.state !== 'preview' || d.summary.revision !== revision || !d.summary.validCount)
                    throw new AppError('CONFLICT', 'Нет корректных строк или версия изменилась.');
                await repo.beforeBatchCommit?.(tx,(await this.batches.rows(id,tx)).filter(r=>!r.issues.length).map(r=>r.input));
                d.committedRevision = revision;
                d.summary.state = 'active';
                await this.batches.save(tx, d);
                await tx.query('update private.batches set request_key=$2,payload_hash=$3 where id=$1', [id, key, frozen]);
            });
            await this.batches.admit(actor, id, 25);
            return { batchId: id };
        }
        throw new AppError('INVALID_INPUT', 'Неизвестная операция импорта.');
    }
    async readLogo(assetId: string, siteId: string): Promise<ArtifactFile> {
        const repo = this.batches.repository, r = (await repo.pool.query('select data from private.import_resources where id=$1', [assetId])).rows[0]?.data as Resource | undefined;
        if (!r || !r.complete || !(await repo.pool.query('select 1 from private.batch_rows r join public.sites s on s.id=r.site_id where r.batch_id=$1 and r.row_number=$2 and r.site_id=$3 and s.input->>\'logoAssetId\'=$4', [r.draftId, r.rowNumber, siteId, assetId])).rowCount)
            throw new AppError('FORBIDDEN', 'Логотип другого сайта.');
        return decodeLogo(await this.bytes(r));
    }
}
