import { createHash, randomUUID, randomBytes } from 'node:crypto';
import type { Principal } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
import type { RestoreReport } from '../../contracts/src/recovery.js';
import { authorize } from '../../core/src/permissions.js';
import type { RecoveryRecord } from './recovery-records.js';
import { managedRecoveryTables, recoveryPath, validateLogicalRecoveryRecord } from './recovery-records.js';
import { SupabaseRepository, type SqlTransaction } from './supabase-repository.js';
import type { R2Store } from './r2-store.js';
import { PostgresRetention } from './postgres-retention.js';
import { payloadRoots, retentionClosure, type PayloadEdge } from '../../core/src/retention.js';
import { checkArtifacts, artifactLimits, artifactPath } from '../../core/src/artifacts.js';
import { assertPostgresPayload } from './postgres-retention.js';
import { verifyValidationPng } from './import-resources.js';
import { projectCheckpoint, parseCheckpointEvidence } from '../../core/src/usage.js';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ttl = 60 * 60 * 1000;
export type IdentityMapping = {
    sourceId: string;
    destinationId: string;
};
export class PostgresBackup {
    constructor(readonly repository: SupabaseRepository, readonly store: R2Store, readonly verifyIdentity?: (id: string) => Promise<{
        id: string;
        email: string;
    }>) { }
    async admin(actor: Principal, tx?: SqlTransaction) { const fresh = tx ? await this.repository.fresh(tx, actor) : await this.repository.transaction(tx => this.repository.fresh(tx, actor)); authorize(fresh, 'site:export'); return fresh; }
    async status(actor: Principal) { await this.admin(actor); return { quarantined: !!(await this.repository.pool.query("select 1 from private.recovery_state where key='quarantine'")).rowCount }; }
    async exportSite(actor: Principal, siteId: string, revisionId: string) { const id = randomUUID(), expiresAt = Date.now() + ttl; return this.repository.transaction(async (tx) => { await this.admin(actor, tx); const revision = await this.repository.revision(revisionId, tx); if (!revision || revision.siteId !== siteId)
        throw new AppError('NOT_FOUND', 'Версия не найдена.'); const manifest = (await tx.query('select manifest from private.artifacts where id=$1 and site_id=$2 and verified', [revision.manifestId, siteId])).rows[0]?.manifest; if (!manifest)
        throw new AppError('NOT_FOUND', 'Артефакт не найден.'); checkArtifacts(manifest.files.map((f: any) => ({ path: f.path, mediaType: f.mediaType, bytes: new Uint8Array() }))); if (manifest.files.reduce((n: number, f: any) => n + f.size, 0) > artifactLimits.totalBytes || manifest.files.some((f: any) => !Number.isSafeInteger(f.size) || f.size < 0 || f.size > artifactLimits.fileBytes || !/^[a-f0-9]{64}$/.test(f.sha256) || !/^[a-f0-9]{40}$/.test(f.sha1) || typeof f.objectKey !== 'string' || !f.objectKey.startsWith('private/artifacts/' + siteId + '/' + revision.manifestId + '/')))
        throw new AppError('INVALID_INPUT', 'Физическая привязка артефакта повреждена.'); if (manifest.files.reduce((n: number, f: any) => n + f.size, 0) > artifactLimits.totalBytes)
        throw new AppError('INVALID_INPUT', 'Архив превышает ёмкость сайта.'); await assertPostgresPayload(tx, { kind: 'artifact', id: revision.manifestId }); await tx.query('insert into private.recovery_snapshots values($1,$2,to_timestamp($3/1000.0),$4)', [id, actor.userId, expiresAt, { kind: 'source', siteId, revisionId, manifestId: revision.manifestId }]); await tx.query('insert into private.payload_pins values($1,$2,$3,to_timestamp($4/1000.0))', [id, 'artifact', revision.manifestId, expiresAt]); for (const [seq, file] of manifest.files.entries())
        await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3)', [id, seq, { type: 'file', root: 'object', path: file.objectKey, sourcePath: file.path, payload: 'payloads/' + seq + '.bin', size: file.size, sha256: file.sha256, mediaType: file.mediaType }]); return { id, records: manifest.files.length, expiresAt }; }); }
    async release(actor: Principal) { await this.repository.transaction(async (tx) => { await this.admin(actor, tx); if ((await tx.query('select 1 from private.publication_reservations where resolution is null limit 1')).rowCount)
        throw new AppError('CONFLICT', 'Сначала подтвердите привязку аккаунта и сверку неизвестных внешних действий по инструкции восстановления.'); await tx.query("delete from private.recovery_state where key='quarantine'"); }, 'exclusive'); return { ok: true }; }
    private async snapshot(actor: Principal, id: string, tx: SqlTransaction) { await this.admin(actor, tx); const row = (await tx.query('select *,expires_at>clock_timestamp() valid from private.recovery_snapshots where id=$1 for update', [id])).rows[0]; if (!row || row.actor_id !== actor.userId || !row.valid)
        throw new AppError('NOT_FOUND', 'Снимок истёк или принадлежит другой сессии.'); return row; }
    async beginSnapshot(actor: Principal) {
        await this.admin(actor);
        const retention = new PostgresRetention(this.repository, this.store.transport);
        await retention.backfill(this.store);
        const id = randomUUID(), now = Date.now();
        return this.repository.transaction(async (tx) => {
            await this.admin(actor, tx);
            await tx.query('insert into private.recovery_snapshots values($1,$2,to_timestamp($3/1000.0),$4)', [id, actor.userId, now + ttl, { kind: 'backup', adapter: 'managed' }]);
            let seq = 0;
            await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3)', [id, seq++, { type: 'header', adapter: 'managed', version: 1, schema: 8, sourceId: id, createdAt: now }]);
            for (const table of managedRecoveryTables) {
                const expression = table === 'private.workers' ? "to_jsonb(t)-'token_hash'" : table === 'private.provider_publications' || table === 'private.provider_accounts' ? "to_jsonb(t)||jsonb_build_object('step_token',null,'step_expires',null)" : 'to_jsonb(t)';
                const inserted = await tx.query('insert into private.recovery_snapshot_records select $1,$2+row_number() over()-1,jsonb_build_object(\'type\',\'row\',\'table\',$3::text,\'row\',' + expression + ') from ' + table + ' t' + (table === 'private.site_operations' ? " where kind<>'controller'" : ''), [id, seq, table]);
                seq += inserted.rowCount ?? 0;
                if (seq > 500000)
                    throw new AppError('INVALID_INPUT', 'Снимок превышает 500000 записей.');
            }
            const objectSource = `select f->>'objectKey' path,f from private.artifacts a left join private.payload_inventory p on p.kind='artifact' and p.id=a.id::text cross join lateral jsonb_array_elements(a.manifest->'files') f where a.verified and coalesce(p.state,'available')='available'
   union all select f->>'objectKey',f from private.checkpoints c left join private.payload_inventory p on p.kind='checkpoint' and p.id=c.id::text cross join lateral jsonb_array_elements((c.metadata#>'{manifest,files}')||jsonb_build_array(c.metadata->'state')) f where coalesce(p.state,'available')='available'
   union all select f->>'key',f-'key'||jsonb_build_object('objectKey',f->>'key') from private.payload_inventory p cross join lateral jsonb_array_elements(p.data->'objects') f where p.kind in ('screenshot','catalog') and p.state='available'`;
            if ((await tx.query("with objects as (" + objectSource + ") select 1 from objects group by path having path is null or count(distinct f)>1 limit 1")).rowCount)
                throw new AppError('INVALID_INPUT', 'Противоречивая опись объектов.');
            await tx.query("insert into private.payload_pins select $1,kind,id,to_timestamp($2/1000.0) from private.payload_inventory where state='available'", [id, now + ttl]);
            const state = await retention.state(tx), evidence = (await tx.query('select id from private.checkpoint_evidence')).rows.map(r => String(r.id)), closure = retentionClosure(state, (await tx.query('select * from private.payload_edges')).rows as PayloadEdge[], new Set(evidence));
            const screenshotIds = new Set([...closure].filter(k => k.startsWith('screenshot:')).map(k => k.slice(11)));
            const pinnedCatalogs = [...closure].filter(k => k.startsWith('catalog:') && k.includes('@')).map(k => k.slice(8)), storedCatalogs = [...new Set((await tx.query("select s.data from private.recovery_state s where s.key='catalog' or (s.key like 'catalog:%' and exists(select 1 from private.payload_inventory p where p.kind='catalog' and p.id='restore-'||split_part(s.key,':',2) and p.state='available'))")).rows.flatMap(r => Array.isArray(r.data.versions) ? r.data.versions : []))];
            await tx.query("update private.recovery_snapshot_records set data=data||jsonb_build_object('pinnedCatalogs',$2::jsonb,'storedCatalogs',$3::jsonb,'hasInstalledCatalog',exists(select 1 from private.recovery_state where key='installed-catalog')) where snapshot_id=$1 and seq=0", [id, JSON.stringify(pinnedCatalogs), JSON.stringify(storedCatalogs)]);
            for (const png of screenshotIds)
                if (!(await tx.query("select 1 from private.payload_inventory where kind='screenshot' and id=$1 and state='available'", [png])).rowCount)
                    throw new AppError('NEEDS_ATTENTION', 'Снимки проверки отсутствуют в управляемом хранилище; полная копия пока недоступна.');
            const files = await tx.query("with objects as (" + objectSource + "),unique_objects as (select distinct path,f from objects) insert into private.recovery_snapshot_records select $1,$2+row_number() over(order by path)-1,jsonb_build_object('type','file','root','object','path',path,'payload','payloads/'||($2+row_number() over(order by path)-1)::text||'.bin','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType') from unique_objects", [id, seq]);
            seq += files.rowCount ?? 0;
            const size = Number((await tx.query('select coalesce(sum(octet_length(data::text)),0) n from private.recovery_snapshot_records where snapshot_id=$1', [id])).rows[0].n);
            if (seq > 500000 || size > (256 * 1024 ** 2))
                throw new AppError('INVALID_INPUT', 'Снимок превышает проверенную ёмкость 500000 записей / 256 МиБ.');
            return { id, records: seq, expiresAt: now + ttl, adapter: 'managed' };
        }, 'exclusive');
    }
    async record(actor: Principal, id: string, seq: number, offset: number) { const data = await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); const row = (await tx.query('select data::text text from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq])).rows[0]; if (!row)
        throw new AppError('NOT_FOUND', 'Запись не найдена.'); return row.text as string; }); const bytes = Buffer.from(data); if (offset < 0 || offset > bytes.length)
        throw new AppError('INVALID_INPUT', 'Некорректное смещение.'); return { size: bytes.length, offset, base64: bytes.subarray(offset, offset + 24000).toString('base64'), nextOffset: offset + 24000 < bytes.length ? offset + 24000 : null }; }
    async resource(actor: Principal, id: string, seq: number, offset: number) { const record = await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); return (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq])).rows[0]?.data as RecoveryRecord | undefined; }); if (!record || record.type !== 'file' || record.root !== 'object')
        throw new AppError('NOT_FOUND', 'Объект не найден.'); if (offset < 0 || offset > record.size)
        throw new AppError('INVALID_INPUT', 'Некорректное смещение.'); const length = Math.min(24000, record.size - offset); let bytes: Uint8Array; if (this.store.transport.range && length)
        bytes = await this.store.transport.range(record.path, offset, length);
    else {
        const full = await this.store.transport.get(record.path, record.size);
        if (full.length !== record.size || sha(full) !== record.sha256)
            throw new AppError('INVALID_INPUT', 'Объект повреждён.');
        bytes = full.subarray(offset, offset + 24000);
    } await this.admin(actor); return { size: record.size, offset, base64: Buffer.from(bytes).toString('base64'), nextOffset: offset + bytes.length < record.size ? offset + bytes.length : null }; }
    async close(actor: Principal, id: string) { await this.repository.transaction(async (tx) => { await this.admin(actor, tx); const row = (await tx.query('select actor_id,data from private.recovery_snapshots where id=$1 for update', [id])).rows[0]; if (!row)
        return; if (row.actor_id !== actor.userId)
        throw new AppError('NOT_FOUND', 'Другой сеанс копирования.'); await tx.query('delete from private.payload_pins where id=$1', [id]); if (row.data.kind === 'restore')
        return; await tx.query('delete from private.recovery_snapshot_records where snapshot_id=$1', [id]); await tx.query('delete from private.recovery_snapshots where id=$1', [id]); }); }
    async beginRestore(actor: Principal, header: RecoveryRecord, mappings: IdentityMapping[], records: number) {
        await this.admin(actor);
        if (header.type !== 'header' || header.adapter !== 'managed' || header.version !== 1 || header.schema !== 8 || !Number.isSafeInteger(records) || records < 1 || records > 500000 || mappings.length > 5000)
            throw new AppError('INVALID_INPUT', 'Неверный формат восстановления.');
        if (!this.verifyIdentity)
            throw new AppError('UNAVAILABLE', 'Проверка получателей Auth не настроена.');
        const verified: Record<string, {
            id: string;
            email: string;
        }> = {};
        for (const mapping of mappings) {
            const identity = await this.verifyIdentity(mapping.destinationId);
            if (identity.id !== mapping.destinationId || Object.values(verified).some(v => v.id === identity.id))
                throw new AppError('INVALID_INPUT', 'Идентификатор назначения не подтверждён.');
            verified[mapping.sourceId] = identity;
        }
        const id = randomUUID();
        return this.repository.transaction(async (tx) => { await this.admin(actor, tx); if ((await tx.query('select 1 from public.sites union all select 1 from private.jobs union all select 1 from private.artifacts limit 1')).rowCount)
            throw new AppError('CONFLICT', 'Целевая установка уже содержит сайты.'); await tx.query("insert into private.recovery_snapshots values($1,$2,clock_timestamp()+interval '1 hour',$3)", [id, actor.userId, { kind: 'restore', header, verified, records }]); return { id }; }, 'exclusive');
    }
    async stageRecord(actor: Principal, id: string, seq: number, record: RecoveryRecord) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 500000 || Buffer.byteLength(JSON.stringify(record)) > 1000000 || !record || !['header', 'row', 'file'].includes(record.type))
            throw new AppError('INVALID_INPUT', 'Неверная запись восстановления.');
        validateLogicalRecoveryRecord(record);
        if (record.type === 'row' && !(managedRecoveryTables as readonly string[]).includes(record.table))
            throw new AppError('INVALID_INPUT', 'Неизвестная таблица.');
        if (record.type === 'file') {
            recoveryPath(record.path);
            if (!['object', 'catalog'].includes(record.root) || !Number.isSafeInteger(record.size) || record.size > (32 * 1024 ** 2) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256))
                throw new AppError('INVALID_INPUT', 'Неверный объект восстановления.');
        }
        await this.repository.transaction(async (tx) => { const snapshot = await this.snapshot(actor, id, tx); if (snapshot.data.kind !== 'restore' || seq >= snapshot.data.records)
            throw new AppError('CONFLICT', 'Неверный сеанс восстановления.'); const old = (await tx.query('select data=$3::jsonb same from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq, record])).rows[0]; if (old && !old.same)
            throw new AppError('CONFLICT', 'Запись уже подготовлена с другим содержимым.'); await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, seq, record]); if (!old) {
            const metadataBytes = Number(snapshot.data.metadataBytes ?? 0) + Buffer.byteLength(JSON.stringify(record)), payloadBytes = Number(snapshot.data.payloadBytes ?? 0) + (record.type === 'file' ? record.size : 0);
            if (metadataBytes > 256 * 1024 ** 2 || payloadBytes + metadataBytes > 48 * 1024 ** 3)
                throw new AppError('INVALID_INPUT', 'Превышена ёмкость метаданных или зашифрованного файла.');
            await tx.query("update private.recovery_snapshots set data=data||jsonb_build_object('metadataBytes',$2::bigint,'payloadBytes',$3::bigint) where id=$1", [id, metadataBytes, payloadBytes]);
        } });
    }
    async addMappings(actor: Principal, id: string, mappings: IdentityMapping[]) { await this.admin(actor); if (!this.verifyIdentity || mappings.length > 50)
        throw new AppError('INVALID_INPUT', 'Неверная привязка Auth.'); const verified: Record<string, {
        id: string;
        email: string;
    }> = {}; for (const m of mappings) {
        const identity = await this.verifyIdentity(m.destinationId);
        if (identity.id !== m.destinationId)
            throw new AppError('FORBIDDEN', 'Получатель не подтверждён.');
        verified[m.sourceId] = identity;
    } await this.repository.transaction(async (tx) => { const snapshot = await this.snapshot(actor, id, tx); if (snapshot.data.kind !== 'restore')
        throw new AppError('CONFLICT', 'Не сеанс восстановления.'); const merged = { ...snapshot.data.verified, ...verified }, values = Object.values(merged) as {
        id: string;
    }[]; if (values.length > 5000 || new Set(values.map(v => v.id)).size !== values.length)
        throw new AppError('INVALID_INPUT', 'Привязки должны сохранять отдельные подтверждённые личности.'); await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{verified}',$2::jsonb) where id=$1", [id, merged]); }); return { ok: true }; }
    async stageMetadataChunk(actor: Principal, id: string, seq: number, index: number, base64: string) { if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 500000 || !Number.isSafeInteger(index) || index < 0 || index > 42 || base64.length > 32000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
        throw new AppError('INVALID_INPUT', 'Неверная часть метаданных.'); const ordinal = 3000000000 + seq * 100 + index, chunk = { type: 'metadata-chunk', index, base64 }; await this.repository.transaction(async (tx) => { const s = await this.snapshot(actor, id, tx); if (s.data.kind !== 'restore' || seq >= s.data.records)
        throw new AppError('CONFLICT', 'Неверный сеанс восстановления.'); const old = (await tx.query('select data=$3::jsonb same from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, ordinal, chunk])).rows[0]; if (old && !old.same)
        throw new AppError('CONFLICT', 'Часть метаданных уже изменена.'); await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, ordinal, chunk]); if (!old) {
        const size = Number(s.data.metadataChunkBytes ?? 0) + Buffer.byteLength(base64, 'base64');
        if (size > 256 * 1024 ** 2)
            throw new AppError('INVALID_INPUT', 'Части метаданных превышают 256 МиБ.');
        await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{metadataChunkBytes}',to_jsonb($2::bigint)) where id=$1", [id, size]);
    } }); }
    async finishMetadata(actor: Principal, id: string, seq: number) { const chunks = await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); return (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 order by seq', [id, 3000000000 + seq * 100, 3000000000 + (seq + 1) * 100])).rows.map(r => r.data); }); let size = 0; const bytes = chunks.map((c, i) => { if (c.index !== i)
        throw new AppError('INVALID_INPUT', 'Часть метаданных отсутствует.'); const bytes = Buffer.from(c.base64, 'base64'); size += bytes.length; if (size > 1000000)
        throw new AppError('INVALID_INPUT', 'Метаданные слишком велики.'); return bytes; }); const record = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(bytes))) as RecoveryRecord; await this.stageRecord(actor, id, seq, record); }
    async stageChunk(actor: Principal, id: string, seq: number, index: number, base64: string) { if (!Number.isSafeInteger(index) || index < 0 || index > 1400 || base64.length > 32000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
        throw new AppError('INVALID_INPUT', 'Неверная часть объекта.'); const ordinal = 1000000000 + seq * 2000 + index; await this.repository.transaction(async (tx) => { const s = await this.snapshot(actor, id, tx); if (s.data.kind !== 'restore')
        throw new AppError('CONFLICT', 'Не сеанс восстановления.'); const file = (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq])).rows[0]?.data; if (file?.type !== 'file')
        throw new AppError('NOT_FOUND', 'Нет описи объекта.'); if ((await tx.query('select 1 from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, 2000000000 + seq])).rowCount)
        throw new AppError('CONFLICT', 'Объект уже проверен; продолжите установку.'); const chunk = { type: 'chunk', seq, index, base64 }, old = (await tx.query('select data=$3::jsonb same from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, ordinal, chunk])).rows[0]; if (old && !old.same)
        throw new AppError('CONFLICT', 'Часть уже изменена.'); await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, ordinal, chunk]); if (!old) {
        const size = Number(s.data.objectStagingBytes ?? 0) + Buffer.byteLength(base64, 'base64');
        if (size > 64 * 1024 ** 2)
            throw new AppError('INVALID_INPUT', 'Завершите проверку подготовленного объекта перед следующим.');
        await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{objectStagingBytes}',to_jsonb($2::bigint)) where id=$1", [id, size]);
    } }); }
    private remap(key: string, id: string) { recoveryPath(key); if (!/^private\/(artifacts|checkpoints|validation|catalog)\//.test(key))
        throw new AppError('INVALID_INPUT', 'Неизвестное пространство объектов.'); const parts = key.split('/'), prefix = parts[1] === 'validation' ? 3 : 4; return [...parts.slice(0, prefix), 'restore-' + id, ...parts.slice(prefix)].join('/'); }
    async finishObject(actor: Principal, id: string, seq: number) { const staged = await this.repository.transaction(async (tx) => { const s = await this.snapshot(actor, id, tx); if (s.data.kind !== 'restore')
        throw new AppError('CONFLICT', 'Не сеанс восстановления.'); return { verified: (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, 2000000000 + seq])).rows[0]?.data, file: (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq])).rows[0]?.data as RecoveryRecord, chunks: (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 order by seq', [id, 1000000000 + seq * 2000, 1000000000 + (seq + 1) * 2000])).rows.map(r => r.data) }; }); if (staged.file?.type !== 'file')
        throw new AppError('NOT_FOUND', 'Нет объекта.'); const file = staged.file; if (staged.verified) {
        if (staged.verified.source !== file.path || staged.verified.sha256 !== file.sha256 || staged.verified.size !== file.size)
            throw new AppError('CONFLICT', 'Проверенный объект изменился.');
        return { ok: true };
    } let size = 0; const buffers: Buffer[] = []; for (const [index, chunk] of staged.chunks.entries()) {
        if (chunk.index !== index)
            throw new AppError('INVALID_INPUT', 'Часть объекта отсутствует.');
        const bytes = Buffer.from(chunk.base64, 'base64');
        size += bytes.length;
        if (size > file.size)
            throw new AppError('INVALID_INPUT', 'Размер объекта превышен.');
        buffers.push(bytes);
    } const bytes = Buffer.concat(buffers); if (size !== file.size || sha(bytes) !== file.sha256)
        throw new AppError('INVALID_INPUT', 'Хэш объекта не совпадает.'); if (file.root === 'object' && file.path.startsWith('private/validation/'))
        verifyValidationPng(bytes); const key = file.root === 'catalog' ? 'private/catalog/restored/' + id + '/' + file.path : this.remap(file.path, id); try {
        await this.store.transport.put(key, bytes, file.mediaType);
    }
    catch {
        const existing = await this.store.transport.get(key, file.size);
        if (sha(existing) !== file.sha256)
            throw new AppError('CONFLICT', 'Подготовленный объект изменился.');
    } await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, 2000000000 + seq, { type: 'verified', source: file.path, key, size: file.size, sha256: file.sha256 }]); const removed = await tx.query("with removed as (delete from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 returning octet_length(decode(data->>'base64','base64')) size) select coalesce(sum(size),0) released from removed", [id, 1000000000 + seq * 2000, 1000000000 + (seq + 1) * 2000]), released = Number(removed.rows[0].released); await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{objectStagingBytes}',to_jsonb(greatest(0,coalesce((data->>'objectStagingBytes')::bigint,0)-$2::bigint))) where id=$1", [id, released]); }); return { ok: true }; }
    async install(actor: Principal, id: string): Promise<RestoreReport> {
        const initial = await this.repository.transaction(async (tx) => { const snapshot = await this.snapshot(actor, id, tx); const installed = (await tx.query("select data from private.recovery_state where key='quarantine' and data->>'restoreId'=$1", [id])).rows[0]; return { snapshot, installed: installed?.data, count: Number((await tx.query('select count(*) n from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000000', [id])).rows[0].n), bytes: Number((await tx.query('select coalesce(sum(octet_length(data::text)),0) n from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000000', [id])).rows[0].n) }; });
        const mappings = initial.snapshot.data.verified as Record<string, {
            id: string;
            email: string;
        }>;
        if (initial.installed)
            return { restoredSites: initial.installed.sites, restoredRevisions: initial.installed.revisions, targetId: id, quarantined: true, sourceUsers: Object.keys(mappings), stagedRemnants: [] };
        if (initial.snapshot.data.kind !== 'restore' || initial.count !== initial.snapshot.data.records)
            throw new AppError('INVALID_INPUT', 'Метаданные восстановления неполны.');
        // Logical rows and physical remapping remain in staged SQL, never whole-installation JS maps.
        if (initial.bytes > 256 * 1024 ** 2)
            throw new AppError('INVALID_INPUT', 'Метаданные превышают 256 МиБ.');
        const stats = (await this.repository.pool.query("select count(*) n,count(distinct data->>'source') unique_n from private.recovery_snapshot_records where snapshot_id=$1 and seq>=2000000000 and seq<3000000000 and data->>'type'='verified'", [id])).rows[0];
        if (stats.n !== stats.unique_n)
            throw new AppError('INVALID_INPUT', 'Повторный физический объект.');
        const keys = { size: Number(stats.n), get: async (source: string): Promise<{
                key: string;
                size: number;
                sha256: string;
            } | undefined> => (await this.repository.pool.query("select data from private.recovery_snapshot_records where snapshot_id=$1 and data->>'type'='verified' and data->>'source'=$2", [id, source])).rows[0]?.data };
        const schema = new Map<string, Set<string>>();
        for (const r of (await this.repository.pool.query("select table_schema,table_name,column_name from information_schema.columns where table_schema in ('public','private')")).rows) {
            const table = r.table_schema + '.' + r.table_name;
            if (!schema.has(table))
                schema.set(table, new Set());
            schema.get(table)!.add(r.column_name);
        }
        let revisions = 0, sites = 0, seen = 0, fileCount = 0;
        const catalog: {
            path: string;
            key: string;
            size: number;
            sha256: string;
        }[] = [], storedBundles: {
            files: {
                path: string;
                key: string;
                size: number;
                sha256: string;
            }[];
            versions: string[];
        }[] = [];
        let installedVersions: string[] | null = null;
        const identityColumns: Record<string, string[]> = { 'public.sites': ['owner_id'], 'public.memberships': ['user_id'], 'public.assignments': ['user_id'], 'private.batches': ['owner_id'], 'private.batch_assignments': ['user_id'], 'private.import_resources': ['owner_id'], 'private.workers': ['enrollment_actor'], 'private.audit': ['actor_id'] };
        const remapFile = async (file: any, required: boolean) => { const mapped = await keys.get(file.objectKey); if (!mapped) {
            if (required)
                throw new AppError('INVALID_INPUT', 'Обязательное содержимое копии отсутствует.');
            file.objectKey = this.remap(file.objectKey, id);
            return;
        } if (mapped.size !== file.size || mapped.sha256 !== file.sha256)
            throw new AppError('INVALID_INPUT', 'Опись содержимого не совпадает с метаданными.'); file.objectKey = mapped.key; };
        for (let after = -1;;) {
            const page = (await this.repository.pool.query('select seq,data from private.recovery_snapshot_records where snapshot_id=$1 and seq>$2 and seq<1000000000 order by seq limit 20', [id, after])).rows;
            if (!page.length)
                break;
            const prepared: {
                seq: number;
                data: unknown;
            }[] = [];
            for (const saved of page) {
                const seq = Number(saved.seq);
                if (seq !== seen++)
                    throw new AppError('INVALID_INPUT', 'Запись отсутствует.');
                after = seq;
                const record = saved.data as RecoveryRecord;
                if (record.type === 'header') {
                    if (seq !== 0 || record.adapter !== 'managed' || record.schema !== 8 || record.version !== 1 || record.sourceId !== initial.snapshot.data.header.sourceId)
                        throw new AppError('INVALID_INPUT', 'Неверный источник копии.');
                    continue;
                }
                if (record.type === 'file') {
                    const mapped = await keys.get(record.path);
                    if (!mapped || mapped.size !== record.size || mapped.sha256 !== record.sha256)
                        throw new AppError('INVALID_INPUT', 'Объект ещё не проверен.');
                    fileCount++;
                    if (record.root === 'catalog' && catalog.length >= 10000)
                        throw new AppError('INVALID_INPUT', 'Слишком много файлов каталога.');
                    if (record.root === 'catalog')
                        catalog.push({ path: record.path, ...mapped });
                    continue;
                }
                if (record.type !== 'row' || !(managedRecoveryTables as readonly string[]).includes(record.table))
                    throw new AppError('INVALID_INPUT', 'Неизвестная запись копии.');
                const row = structuredClone(record.row) as Record<string, any>, table = record.table, columns = schema.get(table);
                if (!columns || Object.keys(row).some(key => !columns.has(key)))
                    throw new AppError('INVALID_INPUT', 'Неизвестное поле метаданных.');
                for (const key of identityColumns[table] ?? [])
                    if (row[key]) {
                        const mapped = mappings[row[key]];
                        if (!mapped)
                            throw new AppError('INVALID_INPUT', 'Не задан подтверждённый пользователь назначения: ' + table + '.' + key + '.');
                        row[key] = mapped.id;
                    }
                const pointers: Record<string, unknown> = {};
                if (table === 'public.users') {
                    const identity = mappings[row.id];
                    if (!identity)
                        throw new AppError('INVALID_INPUT', 'Пользователь не привязан.');
                    row.id = identity.id;
                    row.email = identity.email;
                }
                if (table === 'public.sites') {
                    sites++;
                    pointers.draft_id = row.draft_id;
                    pointers.published_id = row.published_id;
                    row.draft_id = null;
                    row.published_id = null;
                }
                if (table === 'public.revisions')
                    revisions++;
                if (table === 'private.import_resources' && row.data.complete) {
                    const availability = (await this.repository.pool.query("select data#>>'{row,state}' state from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.payload_inventory' and data#>>'{row,kind}'='resource' and data#>>'{row,id}'=$2", [id, row.id])).rows[0]?.state;
                    if (availability !== 'deleted' && availability !== 'claimed') {
                        const stats = (await this.repository.pool.query("select count(*) n,coalesce(sum((length(data#>>'{row,bytes}')-2)/2),0) size from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.import_chunks' and data#>>'{row,resource_id}'=$2", [id, row.id])).rows[0];
                        if (Number(stats.n) > 700 || Number(stats.size) !== row.data.size || row.data.size > 16 * 1024 ** 2)
                            throw new AppError('INVALID_INPUT', 'Состав импорта повреждён.');
                        const chunks = (await this.repository.pool.query("select data#>'{row}' row from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.import_chunks' and data#>>'{row,resource_id}'=$2 order by (data#>>'{row,part}')::int", [id, row.id])).rows, hash = createHash('sha256');
                        for (const [index, c] of chunks.entries()) {
                            if (c.row.part !== index)
                                throw new AppError('INVALID_INPUT', 'Фрагмент импорта отсутствует.');
                            hash.update(Buffer.from(c.row.bytes.slice(2), 'hex'));
                        }
                        if (hash.digest('hex') !== row.data.sha256)
                            throw new AppError('INVALID_INPUT', 'Хэш импорта не совпадает.');
                    }
                }
                if (table === 'private.workers') {
                    row.token_hash = sha(randomBytes(32));
                    row.revoked_at = new Date().toISOString();
                    row.paused = true;
                    row.last_heartbeat = null;
                }
                if (table === 'private.jobs') {
                    pointers.original = { worker_id: row.worker_id, expires_at: row.expires_at, generation: row.generation, state: row.data.state };
                    row.worker_id = null;
                    row.expires_at = null;
                    row.generation = Number(row.generation) + 1;
                    row.data.state = ['completed', 'cancelled'].includes(row.data.state) ? row.data.state : 'paused';
                    pointers.checkpoint_id = row.checkpoint_id;
                    pointers.data = structuredClone(row.data);
                    row.checkpoint_id = null;
                    row.data.checkpointId = null;
                }
                if (table === 'private.site_operations') {
                    if (row.kind === 'controller')
                        continue;
                    row.expires_at = null;
                    row.generation = null;
                }
                if (table === 'private.edit_requests' && row.data.visualSave?.actorId) {
                    const identity = mappings[row.data.visualSave.actorId];
                    if (!identity)
                        throw new AppError('INVALID_INPUT', 'Автор Save не привязан.');
                    row.data.visualSave.actorId = identity.id;
                }
                if (['private.artifacts', 'private.checkpoints'].includes(table)) {
                    const kind = table === 'private.artifacts' ? 'artifact' : 'checkpoint', availability = (await this.repository.pool.query("select data#>>'{row,state}' state from private.recovery_snapshot_records where snapshot_id=$1 and data->>'type'='row' and data->>'table'='private.payload_inventory' and data#>>'{row,kind}'=$2 and data#>>'{row,id}'=$3", [id, kind, row.id])).rows[0]?.state, required = availability === undefined || availability === 'available';
                    const manifest = table === 'private.artifacts' ? row.manifest : row.metadata.manifest;
                    if (!manifest || manifest.id !== row.id || manifest.siteId !== row.site_id || !Array.isArray(manifest.files) || manifest.files.length > 100)
                        throw new AppError('INVALID_INPUT', 'Привязка артефакта повреждена.');
                    checkArtifacts(manifest.files.map((f: any) => ({ path: f.path, mediaType: f.mediaType, bytes: new Uint8Array() })));
                    if (manifest.files.reduce((n: number, f: any) => n + f.size, 0) > artifactLimits.totalBytes || manifest.files.some((f: any) => !Number.isSafeInteger(f.size) || f.size < 0 || f.size > artifactLimits.fileBytes || !/^[a-f0-9]{64}$/.test(f.sha256) || !/^[a-f0-9]{40}$/.test(f.sha1) || typeof f.objectKey !== 'string' || !f.objectKey.startsWith('private/' + (kind === 'artifact' ? 'artifacts' : 'checkpoints') + '/' + row.site_id + '/' + row.id + '/')))
                        throw new AppError('INVALID_INPUT', 'Физическая привязка артефакта повреждена.');
                    if (table === 'private.checkpoints' && required) {
                        const c = row.metadata.checkpoint, stateFile = row.metadata.state;
                        if (!c || c.id !== row.id || c.jobId !== row.job_id || c.manifestId !== row.manifest_id || !stateFile || c.stateKey !== stateFile.objectKey)
                            throw new AppError('INVALID_INPUT', 'Привязка контрольной точки повреждена.');
                        const read = async (f: any) => { const physical = await keys.get(f.objectKey); if (!physical)
                            throw new AppError('INVALID_INPUT', 'Файл проверки отсутствует.'); const bytes = await this.store.transport.get(physical.key, f.size); if (bytes.length !== f.size || sha(bytes) !== f.sha256 || createHash('sha1').update(bytes).digest('hex') !== f.sha1)
                            throw new AppError('INVALID_INPUT', 'Файл проверки повреждён.'); return bytes; }, state = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await read(stateFile)));
                        if (state.siteId !== row.site_id || state.jobId !== row.job_id || state.manifestId !== undefined && state.manifestId !== row.manifest_id)
                            throw new AppError('INVALID_INPUT', 'Состояние принадлежит другому заданию.');
                        const files = [];
                        for (const f of manifest.files)
                            files.push({ path: f.path, mediaType: f.mediaType, bytes: await read(f) });
                        const projected = projectCheckpoint(c, state, files, row.expected_checkpoint_id), saved = (await this.repository.pool.query("select data#>'{row,data}' data from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.checkpoint_evidence' and data#>>'{row,id}'=$2", [id, row.id])).rows[0]?.data;
                        if (saved && parseCheckpointEvidence(saved).digest !== projected.evidence.digest)
                            throw new AppError('INVALID_INPUT', 'Свидетельство не соответствует сохранённым байтам.');
                    }
                    if (table === 'private.artifacts') {
                        for (const file of row.manifest.files)
                            await remapFile(file, required);
                    }
                    else {
                        const metadata = row.metadata, sourceKey = metadata.checkpoint.stateKey;
                        for (const file of metadata.manifest.files)
                            remapFile(file, required);
                        if (metadata.state)
                            await remapFile(metadata.state, required);
                        const mappedState = await keys.get(sourceKey);
                        if (mappedState)
                            metadata.checkpoint.stateKey = mappedState.key;
                    }
                }
                if (table === 'private.upload_preparations') {
                    for (const file of row.metadata.manifest?.files ?? [])
                        await remapFile(file, false);
                    if (row.metadata.state)
                        await remapFile(row.metadata.state, false);
                    if (row.metadata.checkpoint?.stateKey) {
                        const mapped = await keys.get(row.metadata.checkpoint.stateKey);
                        if (mapped)
                            row.metadata.checkpoint.stateKey = mapped.key;
                    }
                    ;
                }
                if (table === 'private.payload_inventory') {
                    if (row.state === 'available' && ['artifact', 'checkpoint'].includes(row.kind)) {
                        const tableName = row.kind === 'artifact' ? 'private.artifacts' : 'private.checkpoints', saved = (await this.repository.pool.query("select data#>'{row}' row from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'=$2 and data#>>'{row,id}'=$3", [id, tableName, row.id])).rows[0]?.row;
                        if (!saved || saved.site_id !== row.site_id)
                            throw new AppError('INVALID_INPUT', 'Опись принадлежит другому сайту.');
                        const manifest = row.kind === 'artifact' ? saved.manifest : saved.metadata.manifest, expected = [...manifest.files, ...(row.kind === 'checkpoint' ? [saved.metadata.state] : [])];
                        if (expected.length !== row.data.objects.length || expected.some((f: any, index: number) => { const o = row.data.objects[index]; return f.objectKey !== o.key || f.size !== o.size || f.sha256 !== o.sha256 || f.mediaType !== o.mediaType; }))
                            throw new AppError('INVALID_INPUT', 'Состав описи не соответствует неизменяемым метаданным.');
                    }
                    if (row.state === 'available' && row.kind === 'screenshot') {
                        const producer = row.data.producer, job = producer && (await this.repository.pool.query("select data#>>'{row,site_id}' site_id from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.jobs' and data#>>'{row,id}'=$2", [id, producer.jobId])).rows[0];
                        if (!job || job.site_id !== row.site_id || row.data.objects.length !== 1 || row.data.objects[0].mediaType !== 'image/png' || !row.data.objects[0].key.startsWith('private/validation/' + row.site_id + '/'))
                            throw new AppError('INVALID_INPUT', 'Производитель снимка повреждён.');
                    }
                    const sourceObjects = structuredClone(row.data.objects ?? []);
                    for (const file of row.data.objects ?? []) {
                        const mapped = await keys.get(file.key);
                        if (!mapped && row.state === 'available' && row.kind !== 'resource')
                            throw new AppError('INVALID_INPUT', 'Обязательная физическая опись отсутствует.');
                        if (!mapped && row.state === 'staging' && row.kind !== 'resource')
                            file.key = this.remap(file.key, id);
                        if (mapped) {
                            if (mapped.size !== file.size || mapped.sha256 !== file.sha256)
                                throw new AppError('INVALID_INPUT', 'Физическая опись повреждена.');
                            file.key = mapped.key;
                        }
                    }
                    row.data.originalObjects ??= row.data.sourceObjects ?? sourceObjects;
                    row.data.sourceObjects = sourceObjects;
                    row.data.sourceInstallation = initial.snapshot.data.header.sourceId;
                    row.first_orphan_at = null;
                    row.claim_token = null;
                    if (row.state === 'claimed')
                        row.state = 'deleted';
                }
                if (table === 'private.provider_accounts' || table === 'private.provider_publications') {
                    row.step_token = null;
                    row.step_expires = null;
                }
                if (table === 'private.recovery_state') {
                    if (row.key === 'catalog' || String(row.key).startsWith('catalog:')) {
                        const state = (await this.repository.pool.query("select data#>>'{row,state}' state from private.recovery_snapshot_records where snapshot_id=$1 and data->>'table'='private.payload_inventory' and data#>>'{row,kind}'='catalog' and data#>>'{row,id}'=$2", [id, 'restore-' + String(row.key).slice(8)])).rows[0]?.state;
                        if (!['claimed', 'deleted'].includes(state)) {
                            for (const file of row.data.files ?? []) {
                                const mapped = await keys.get(file.key);
                                if (!mapped || mapped.sha256 !== file.sha256 || mapped.size !== file.size)
                                    throw new AppError('INVALID_INPUT', 'Закреплённый каталог отсутствует.');
                                file.key = mapped.key;
                            }
                            storedBundles.push(row.data);
                        }
                    }
                    else if (row.key === 'installed-catalog') {
                        if (!Array.isArray(row.data.versions) || row.data.versions.length > 10000 || row.data.versions.some((v: unknown) => typeof v !== 'string'))
                            throw new AppError('INVALID_INPUT', 'Текущий каталог повреждён.');
                        installedVersions = row.data.versions;
                    }
                    else
                        row.key = 'provenance:' + initial.snapshot.data.header.sourceId + ':' + row.key;
                }
                prepared.push({ seq: 4000000000 + seq, data: { type: 'prepared', table, row, pointers } });
            }
            await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); for (const r of prepared)
                await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict(snapshot_id,seq) do update set data=excluded.data', [id, r.seq, r.data]); });
        }
        if (seen !== initial.count || fileCount !== keys.size)
            throw new AppError('INVALID_INPUT', 'Состав объектов не совпадает с копией.');
        const catalogVersions = catalog.length ? await this.verifyCatalog(catalog) : [], availableVersions = new Set(catalogVersions);
        for (const bundle of storedBundles) {
            const verified = await this.verifyCatalog(bundle.files);
            if (!Array.isArray(bundle.versions) || bundle.versions.some(v => !verified.includes(v)))
                throw new AppError('INVALID_INPUT', 'Версия закреплённого каталога не подтверждена байтами.');
            for (const v of verified)
                availableVersions.add(v);
        }
        const required = initial.snapshot.data.header.pinnedCatalogs ?? [];
        if (!Array.isArray(required) || required.length > 10000 || required.some((v: unknown) => typeof v !== 'string' || !availableVersions.has(v)))
            throw new AppError('INVALID_INPUT', 'Закреплённая версия отсутствует в независимой копии.');
        if (!installedVersions || installedVersions.some(v => !availableVersions.has(v)))
            throw new AppError('INVALID_INPUT', 'Текущий установленный каталог отсутствует в копии.');
        const order = ['public.users', 'public.memberships', 'public.sites', 'private.batches', 'private.workers', 'private.jobs', 'private.artifacts', 'private.checkpoints', 'public.revisions', 'public.assignments', 'private.edit_requests', 'public.chat', 'private.deployments', 'public.health', 'private.batch_rows', 'private.batch_assignments', 'private.import_resources', 'private.import_chunks', 'private.publication_reservations', 'private.site_operations', 'private.provider_accounts', 'private.provider_publications', 'private.publication_attempts', 'private.upload_preparations', 'private.catalog', 'private.audit', 'private.payload_inventory', 'private.payload_edges', 'private.checkpoint_evidence', 'private.job_usage', 'private.recovery_state'];
        await this.repository.transaction(async (tx) => {
            await this.snapshot(actor, id, tx);
            if ((await tx.query('select 1 from public.sites union all select 1 from private.jobs union all select 1 from private.artifacts limit 1')).rowCount)
                throw new AppError('CONFLICT', 'Цель перестала быть пустой.');
            await tx.query("select set_config('site_factory.restore','1',true)");
            for (const table of order) {
                const conflict = table === 'public.users' || table === 'public.memberships' ? ' on conflict do nothing' : '', source = "select data->'row' row from private.recovery_snapshot_records where snapshot_id=$1 and seq>=4000000000 and data->>'table'=$2";
                if (table === 'private.checkpoints' || table === 'public.revisions') {
                    const parent = table === 'public.revisions' ? 'parent_id' : 'expected_checkpoint_id', tree = "with recursive source as (" + source + "), tree as (select row,0 depth from source where row->>'" + parent + "' is null union all select s.row,t.depth+1 from source s join tree t on s.row->>'" + parent + "'=t.row->>'id' where t.depth<500000) ";
                    const counts = (await tx.query(tree + 'select (select count(*) from source) total,(select count(*) from tree) reachable', [id, table])).rows[0];
                    if (counts.total !== counts.reachable)
                        throw new AppError('INVALID_INPUT', 'Цикл предшественников.');
                    await tx.query(tree + 'insert into ' + table + ' select (jsonb_populate_record(null::' + table + ',row)).* from tree order by depth', [id, table]);
                }
                else
                    await tx.query('insert into ' + table + (table === 'private.audit' ? ' overriding system value' : '') + ' select (jsonb_populate_record(null::' + table + ',row)).* from (' + source + ') s' + conflict, [id, table]);
            }
            await tx.query("update public.sites s set draft_id=(p.data#>>'{pointers,draft_id}')::uuid,published_id=(p.data#>>'{pointers,published_id}')::uuid from private.recovery_snapshot_records p where p.snapshot_id=$1 and p.seq>=4000000000 and p.data->>'table'='public.sites' and s.id=(p.data#>>'{row,id}')::uuid", [id]);
            await tx.query("update private.jobs j set checkpoint_id=(p.data#>>'{pointers,checkpoint_id}')::uuid,data=p.data#>'{pointers,data}' from private.recovery_snapshot_records p where p.snapshot_id=$1 and p.seq>=4000000000 and p.data->>'table'='private.jobs' and j.id=(p.data#>>'{row,id}')::uuid", [id]);
            if (catalog.length) {
                await tx.query('insert into private.recovery_state values($1,$2)', ['catalog:' + id, { sourceId: initial.snapshot.data.header.sourceId, files: catalog, versions: catalogVersions }]);
                await tx.query('insert into private.payload_inventory values($1,$2,null,$3,$4,null,null)', ['catalog', 'restore-' + id, { kind: 'catalog', id: 'restore-' + id, siteId: null, objects: catalog.map(f => ({ key: f.key, size: f.size, sha256: f.sha256, mediaType: 'application/octet-stream' })), createdAt: Date.now(), protectUntil: 0, state: 'available', firstOrphanAt: null, claimToken: null }, 'available']);
                for (const version of catalogVersions)
                    await tx.query("insert into private.payload_edges values('catalog',$1,'retained','catalog',$2) on conflict do nothing", [version, 'restore-' + id]);
            }
            await tx.query("select setval('private.publication_settled_sequence',coalesce((select max(settled_seq) from private.provider_publications),0)+1,false)");
            await tx.query("select setval(pg_get_serial_sequence('private.audit','id'),coalesce((select max(id) from private.audit),0)+1,false)");
            await tx.query('insert into private.recovery_state values($1,$2)', ['installation', { restoreId: id, sourceId: initial.snapshot.data.header.sourceId, restoredAt: Date.now(), authMapping: Object.fromEntries(Object.entries(mappings).map(([source, destination]) => [source, destination.id])) }]);
            await tx.query('insert into private.recovery_state values($1,$2)', ['quarantine', { sourceId: initial.snapshot.data.header.sourceId, mappings, restoreId: id, sites, revisions, physicalProvenanceSnapshot: id, providerReconciliationRequired: true }]);
        }, 'exclusive');
        return { restoredSites: sites, restoredRevisions: revisions, targetId: id, quarantined: true, sourceUsers: Object.keys(mappings), stagedRemnants: [] };
    }
    private async verifyCatalog(files: {
        path: string;
        key: string;
        size: number;
        sha256: string;
    }[]) { const index = files.find(f => f.path === 'templates/catalog.json'), reference = files.find(f => f.path === 'references/catalog.json'); if (!index || !reference || index.size > 200000 || reference.size > 2000000)
        throw new AppError('INVALID_INPUT', 'Опись материалов отсутствует.'); const read = async (f: typeof index) => { const bytes = await this.store.transport.get(f.key, f.size); if (bytes.length !== f.size || sha(bytes) !== f.sha256)
        throw new AppError('INVALID_INPUT', 'Опись материалов повреждена.'); return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }, styles = await read(index), references = await read(reference); if (!Array.isArray(styles) || styles.length > 1000 || !Array.isArray(references) || references.length > 10000)
        throw new AppError('INVALID_INPUT', 'Неверная опись материалов.'); return styles.map(s => { if (typeof s.id !== 'string' || !/^[a-z][a-z-]+$/.test(s.id) || typeof s.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(s.version) || !Array.isArray(s.files) || !s.files.length || s.files.length > 100 || s.files.some((p: unknown) => typeof p !== 'string' || !files.some(f => f.path === 'templates/' + s.id + '/' + artifactPath(p))) || !Array.isArray(s.referenceIds) || s.referenceIds.some((id: unknown) => !references.some(r => r.id === id)))
        throw new AppError('INVALID_INPUT', 'Файлы версии или референсы отсутствуют.'); return s.id + '@' + s.version; }); }
}
