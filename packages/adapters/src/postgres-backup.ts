import { PostgresRecoveryTransfer } from './postgres-recovery-transfer.js';
import { preflightPostgres } from './retention-sql.js';import { createHash, randomUUID, randomBytes } from 'node:crypto';
import type { Principal } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
import type { RestoreReport } from '../../contracts/src/recovery.js';
import { authorize } from '../../core/src/permissions.js';
import type { RecoveryRecord } from './recovery-records.js';
import { managedRecoveryTables, recoveryPath, validateLogicalRecoveryRecord } from './recovery-records.js';
import { SupabaseRepository, type SqlTransaction } from './supabase-repository.js';
import type { R2Store } from './r2-store.js';
import { PostgresRetention } from './postgres-retention.js';
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
    async exportSite(actor: Principal, siteId: string, revisionId: string, scope?:string) { const id = randomUUID(), expiresAt = Date.now() + ttl; return this.repository.transaction(async (tx) => { await this.admin(actor, tx); const revision = await this.repository.revision(revisionId, tx); if (!revision || revision.siteId !== siteId)
        throw new AppError('NOT_FOUND', 'Версия не найдена.'); const manifest = (await tx.query('select manifest from private.artifacts where id=$1 and site_id=$2 and verified', [revision.manifestId, siteId])).rows[0]?.manifest; if (!manifest)
        throw new AppError('NOT_FOUND', 'Артефакт не найден.'); checkArtifacts(manifest.files.map((f: any) => ({ path: f.path, mediaType: f.mediaType, bytes: new Uint8Array() }))); if (manifest.files.reduce((n: number, f: any) => n + f.size, 0) > artifactLimits.totalBytes || manifest.files.some((f: any) => !Number.isSafeInteger(f.size) || f.size < 0 || f.size > artifactLimits.fileBytes || !/^[a-f0-9]{64}$/.test(f.sha256) || !/^[a-f0-9]{40}$/.test(f.sha1) || typeof f.objectKey !== 'string' || !f.objectKey.startsWith('private/artifacts/' + siteId + '/' + revision.manifestId + '/')))
        throw new AppError('INVALID_INPUT', 'Физическая привязка артефакта повреждена.'); if (manifest.files.reduce((n: number, f: any) => n + f.size, 0) > artifactLimits.totalBytes)
        throw new AppError('INVALID_INPUT', 'Архив превышает ёмкость сайта.'); await assertPostgresPayload(tx, { kind: 'artifact', id: revision.manifestId }); await tx.query('insert into private.recovery_snapshots values($1,$2,to_timestamp($3/1000.0),$4)', [id, actor.userId, expiresAt, { kind: 'source', siteId, revisionId, manifestId: revision.manifestId }]); await tx.query('insert into private.payload_pins values($1,$2,$3,to_timestamp($4/1000.0))', [id, 'artifact', revision.manifestId, expiresAt]); for (const [seq, file] of manifest.files.entries())
        await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3)', [id, seq, { type: 'file', root: 'object', path: file.objectKey, sourcePath: file.path, payload: 'payloads/' + seq + '.bin', size: file.size, sha256: file.sha256, mediaType: file.mediaType }]); if(scope)await new PostgresRecoveryTransfer(this,scope).bindIssued(tx,id,id,manifest.files.length,0); return { id, records: manifest.files.length, expiresAt }; }); }
    async release(actor: Principal) { await this.repository.transaction(async (tx) => { await this.admin(actor, tx); if ((await tx.query('select 1 from private.publication_reservations where resolution is null limit 1')).rowCount)
        throw new AppError('CONFLICT', 'Сначала подтвердите привязку аккаунта и сверку неизвестных внешних действий по инструкции восстановления.'); await tx.query("delete from private.recovery_state where key='quarantine'"); }, 'exclusive'); return { ok: true }; }
    async snapshot(actor: Principal, id: string, tx: SqlTransaction) { await this.admin(actor, tx); const row = (await tx.query('select *,expires_at>clock_timestamp() valid from private.recovery_snapshots where id=$1 for update', [id])).rows[0]; if (!row || row.actor_id !== actor.userId || !row.valid)
        throw new AppError('NOT_FOUND', 'Снимок истёк или принадлежит другой сессии.'); return row; }
    async beginSnapshot(actor: Principal,scope?:string) {
        await this.admin(actor);
        this.repository.requireSnapshotConnection();
        const retention = new PostgresRetention(this.repository, this.store.transport);
        await this.repository.transaction(async (tx) => { await tx.query("set local statement_timeout='15s';set local work_mem='4MB'"); await preflightPostgres(tx, true); });
        await retention.backfill(this.store);
        const id = randomUUID(), now = Date.now();
        return this.repository.captureSnapshot(async (tx) => {
            await this.admin(actor, tx);
            await tx.query("set local statement_timeout='15s';set local work_mem='4MB'");
            await preflightPostgres(tx, true);
            await retention.closure(tx, now, true);
            await tx.query('insert into private.recovery_snapshots values($1,$2,to_timestamp($3/1000.0),$4)', [id, actor.userId, now + ttl, { kind: 'backup', adapter: 'managed' }]);
            let seq = 0;
            await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3)', [id, seq++, { type: 'header', adapter: 'managed', version: 1, schema: 8, sourceId: id, createdAt: now }]);
            for (const table of managedRecoveryTables) {
                const expression = table === 'private.workers' ? "to_jsonb(t)-'token_hash'" : table === 'private.provider_publications' || table === 'private.provider_accounts' ? "to_jsonb(t)||jsonb_build_object('step_token',null,'step_expires',null)" : 'to_jsonb(t)';
                const inserted = await tx.query('insert into private.recovery_snapshot_records select $1,$2+row_number() over()-1,jsonb_build_object(\'type\',\'row\',\'table\',$3::text,\'row\',' + expression + ') from ' + table + ' t' + (table === 'private.site_operations' ? " where kind<>'controller'" : ''), [id, seq, table]);
                seq += inserted.rowCount ?? 0;
                if (seq > 1000000)
                    throw new AppError('INVALID_INPUT', 'Снимок превышает 1000000 записей.');
            }
            const objectSource = `select f->>'objectKey' path,f from private.artifacts a left join private.payload_inventory p on p.kind='artifact' and p.id=a.id::text cross join lateral jsonb_array_elements(a.manifest->'files') f where a.verified and coalesce(p.state,'available')='available'
   union all select f->>'objectKey',f from private.checkpoints c left join private.payload_inventory p on p.kind='checkpoint' and p.id=c.id::text cross join lateral jsonb_array_elements((c.metadata#>'{manifest,files}')||jsonb_build_array(c.metadata->'state')) f where coalesce(p.state,'available')='available'
   union all select f->>'key',f-'key'||jsonb_build_object('objectKey',f->>'key') from private.payload_inventory p cross join lateral jsonb_array_elements(p.data->'objects') f where p.kind in ('screenshot','catalog') and p.state='available'`;
            if ((await tx.query("with objects as (" + objectSource + ") select 1 from objects group by path having path is null or count(distinct f)>1 limit 1")).rowCount)
                throw new AppError('INVALID_INPUT', 'Противоречивая опись объектов.');
            await tx.query("insert into private.payload_pins select $1,kind,id,to_timestamp($2/1000.0) from private.payload_inventory where state='available'", [id, now + ttl]);
            if ((await tx.query("select 1 from retention_protected r left join private.payload_inventory p on p.kind=r.kind and p.id=r.id where r.kind='screenshot' and (p.state is null or p.state<>'available') limit 1")).rowCount)
                throw new AppError('NEEDS_ATTENTION', 'Снимки проверки отсутствуют; полная копия пока недоступна.');
            const versions = async (query: string) => { const n = Number((await tx.query('select count(*) n from (' + query + ') versions')).rows[0].n); if (n > 10000)
                throw new AppError('INVALID_INPUT', 'Заголовок содержит более10000 версий каталога.'); return (await tx.query(query)).rows.map(r => String(r.version)); };
            const pinnedCatalogs = await versions("select distinct id version from retention_protected where kind='catalog' and position('@' in id)>0");
            const storedCatalogs = await versions("select distinct v version from private.recovery_state s cross join lateral jsonb_array_elements_text(s.data->'versions') v where s.key='catalog' or (s.key like 'catalog:%' and exists(select 1 from private.payload_inventory p where p.kind='catalog' and p.id='restore-'||split_part(s.key,':',2) and p.state='available'))");
            await tx.query("update private.recovery_snapshot_records set data=data||jsonb_build_object('pinnedCatalogs',$2::jsonb,'storedCatalogs',$3::jsonb,'hasInstalledCatalog',exists(select 1 from private.recovery_state where key='installed-catalog')) where snapshot_id=$1 and seq=0", [id, JSON.stringify(pinnedCatalogs), JSON.stringify(storedCatalogs)]);
            const firstResource=seq;
            const files = await tx.query("with objects as (" + objectSource + "),unique_objects as (select distinct path,f from objects) insert into private.recovery_snapshot_records select $1,$2+row_number() over(order by path)-1,jsonb_build_object('type','file','root','object','path',path,'payload','payloads/'||($2+row_number() over(order by path)-1)::text||'.bin','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType') from unique_objects", [id, seq]);
            seq += files.rowCount ?? 0;
            const size = Number((await tx.query('select coalesce(sum(octet_length(data::text)),0) n from private.recovery_snapshot_records where snapshot_id=$1', [id])).rows[0].n);
            if (seq > 1000000 || size > (768 * 1024 ** 2))
                throw new AppError('INVALID_INPUT', 'Снимок превышает проверенную ёмкость 1000000 записей / 768 МиБ.');
            if(scope)await new PostgresRecoveryTransfer(this,scope).bindIssued(tx,id,id,seq,firstResource);
            return { id, records: seq, expiresAt: now + ttl, adapter: 'managed' };
        }, async (tx) => { await this.admin(actor, tx); }).catch(async (error) => { await this.repository.transaction(async (tx) => { await tx.query('delete from private.payload_pins where id=$1', [id]); await tx.query('delete from private.recovery_snapshot_records where snapshot_id=$1', [id]); await tx.query('delete from private.recovery_transfers where id=$1',[id]); await tx.query('delete from private.recovery_snapshots where id=$1', [id]); }); throw error; });
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
    async close(actor: Principal, id: string) { if((await this.repository.pool.query('select 1 from private.recovery_transfers where id=$1',[id])).rowCount){await new PostgresRecoveryTransfer(this).cancel(actor,id);return;} await this.repository.transaction(async (tx) => { await this.admin(actor, tx); const row = (await tx.query('select actor_id,data from private.recovery_snapshots where id=$1 for update', [id])).rows[0]; if (!row)
        return; if (row.actor_id !== actor.userId)
        throw new AppError('NOT_FOUND', 'Другой сеанс копирования.'); await tx.query('delete from private.payload_pins where id=$1', [id]); if (row.data.kind === 'restore')
        return; await tx.query('delete from private.recovery_snapshot_records where snapshot_id=$1', [id]); await tx.query('delete from private.recovery_snapshots where id=$1', [id]); }); }
    async beginRestore(actor: Principal, header: RecoveryRecord, mappings: IdentityMapping[], records: number, inventoryDigest?:unknown,scope?:string) {
        await this.admin(actor);
        if (header.type !== 'header' || header.adapter !== 'managed' || header.version !== 1 || header.schema !== 8 || !Number.isSafeInteger(records) || records < 1 || records > 1000000 || mappings.length > 5000)
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
        if(inventoryDigest!==undefined&&(typeof inventoryDigest!=='string'||!/^[a-f0-9]{64}$/.test(inventoryDigest)))throw new AppError('INVALID_INPUT','Неверная привязка описи архива.');
        const id = randomUUID();
        return this.repository.transaction(async (tx) => {
            await this.admin(actor, tx);
            if ((await tx.query('select 1 from public.sites union all select 1 from private.jobs union all select 1 from private.artifacts limit 1')).rowCount)
                throw new AppError('CONFLICT', 'Целевая установка уже содержит сайты.');
            await tx.query("insert into private.recovery_snapshots values($1,$2,clock_timestamp()+interval '1 hour',$3)", [id, actor.userId, { kind: 'restore', header, verified, records,...(inventoryDigest?{inventoryDigest}:{}) }]);
            if(scope)await new PostgresRecoveryTransfer(this,scope).bindIssued(tx,id,header.sourceId,records,records,inventoryDigest);
            return { id };
        }, 'exclusive');
    }
    async stageRecord(actor: Principal, id: string, seq: number, record: RecoveryRecord) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 1000000 || Buffer.byteLength(JSON.stringify(record)) > 1000000 || !record || !['header', 'row', 'file'].includes(record.type))
            throw new AppError('INVALID_INPUT', 'Неверная запись восстановления.');
        validateLogicalRecoveryRecord(record);
        if (record.type === 'row' && !(managedRecoveryTables as readonly string[]).includes(record.table))
            throw new AppError('INVALID_INPUT', 'Неизвестная таблица.');
        if (record.type === 'file') {
            recoveryPath(record.path);
            if (!['object', 'catalog'].includes(record.root) || !Number.isSafeInteger(record.size) || record.size > (32 * 1024 ** 2) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256))
                throw new AppError('INVALID_INPUT', 'Неверный объект восстановления.');
        }
        await this.repository.transaction(async (tx) => {
            const snapshot = await this.snapshot(actor, id, tx);
            if (snapshot.data.kind !== 'restore' || seq >= snapshot.data.records)
                throw new AppError('CONFLICT', 'Неверный сеанс восстановления.');
            const old = (await tx.query('select data=$3::jsonb same from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq, record])).rows[0];
            if (old && !old.same)
                throw new AppError('CONFLICT', 'Запись уже подготовлена с другим содержимым.');
            await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, seq, record]);
            if (!old) {
                const metadataBytes = Number(snapshot.data.metadataBytes ?? 0) + Buffer.byteLength(JSON.stringify(record)), payloadBytes = Number(snapshot.data.payloadBytes ?? 0) + (record.type === 'file' ? record.size : 0);
                if (metadataBytes > 768 * 1024 ** 2 || payloadBytes + metadataBytes > 48 * 1024 ** 3)
                    throw new AppError('INVALID_INPUT', 'Превышена ёмкость метаданных или зашифрованного файла.');
                await tx.query("update private.recovery_snapshots set data=data||jsonb_build_object('metadataBytes',$2::bigint,'payloadBytes',$3::bigint) where id=$1", [id, metadataBytes, payloadBytes]);
            }
        });
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
        throw new AppError('CONFLICT', 'Не сеанс восстановления.'); if((await tx.query("select 1 from private.recovery_transfers where id=$1 and data ? 'mappingDigest'",[id])).rowCount){if(Object.entries(verified).some(([key,value])=>snapshot.data.verified[key]?.id!==value.id))throw new AppError('CONFLICT','Привязки уже закреплены началом передачи.');return;} const merged = { ...snapshot.data.verified, ...verified }, values = Object.values(merged) as {
        id: string;
    }[]; if (values.length > 5000 || new Set(values.map(v => v.id)).size !== values.length)
        throw new AppError('INVALID_INPUT', 'Привязки должны сохранять отдельные подтверждённые личности.'); await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{verified}',$2::jsonb) where id=$1", [id, merged]); }); return { ok: true }; }
    async stageMetadataChunk(actor: Principal, id: string, seq: number, index: number, base64: string) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 1000000 || !Number.isSafeInteger(index) || index < 0 || index > 42 || base64.length > 32000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
            throw new AppError('INVALID_INPUT', 'Неверная часть метаданных.');
        const ordinal = 5000000000 + seq * 100 + index, chunk = { type: 'metadata-chunk', index, base64 };
        await this.repository.transaction(async (tx) => {
            const s = await this.snapshot(actor, id, tx);
            if (s.data.kind !== 'restore' || seq >= s.data.records)
                throw new AppError('CONFLICT', 'Неверный сеанс восстановления.');
            const old = (await tx.query('select data=$3::jsonb same from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, ordinal, chunk])).rows[0];
            if (old && !old.same)
                throw new AppError('CONFLICT', 'Часть метаданных уже изменена.');
            await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, ordinal, chunk]);
            if (!old) {
                const size = Number(s.data.metadataChunkBytes ?? 0) + Buffer.byteLength(base64, 'base64');
                if (size > 768 * 1024 ** 2)
                    throw new AppError('INVALID_INPUT', 'Части метаданных превышают 768 МиБ.');
                await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{metadataChunkBytes}',to_jsonb($2::bigint)) where id=$1", [id, size]);
            }
        });
    }
    async finishMetadata(actor: Principal, id: string, seq: number) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 1000000)
            throw new AppError('INVALID_INPUT', 'Неверный номер записи.');
        const chunks = await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); return (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 order by seq', [id, 5000000000 + seq * 100, 5000000000 + (seq + 1) * 100])).rows.map(r => r.data); });
        let size = 0;
        const bytes = chunks.map((c, i) => {
            if (c.index !== i)
                throw new AppError('INVALID_INPUT', 'Часть метаданных отсутствует.');
            const bytes = Buffer.from(c.base64, 'base64');
            size += bytes.length;
            if (size > 1000000)
                throw new AppError('INVALID_INPUT', 'Метаданные слишком велики.');
            return bytes;
        });
        const record = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(bytes))) as RecoveryRecord;
        await this.stageRecord(actor, id, seq, record);
    }
    async stageChunk(actor: Principal, id: string, seq: number, index: number, base64: string) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 1000000 || !Number.isSafeInteger(index) || index < 0 || index > 1400 || base64.length > 32000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
            throw new AppError('INVALID_INPUT', 'Неверная часть объекта.');
        const ordinal = 1000000000 + seq * 2000 + index;
        await this.repository.transaction(async (tx) => {
            const s = await this.snapshot(actor, id, tx);
            if (s.data.kind !== 'restore')
                throw new AppError('CONFLICT', 'Не сеанс восстановления.');
            const file = (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq])).rows[0]?.data;
            if (file?.type !== 'file')
                throw new AppError('NOT_FOUND', 'Нет описи объекта.');
            if ((await tx.query('select 1 from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, 4000000000 + seq])).rowCount)
                throw new AppError('CONFLICT', 'Объект уже проверен; продолжите установку.');
            const chunk = { type: 'chunk', seq, index, base64 }, old = (await tx.query('select data=$3::jsonb same from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, ordinal, chunk])).rows[0];
            if (old && !old.same)
                throw new AppError('CONFLICT', 'Часть уже изменена.');
            await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, ordinal, chunk]);
            if (!old) {
                const size = Number(s.data.objectStagingBytes ?? 0) + Buffer.byteLength(base64, 'base64');
                if (size > 64 * 1024 ** 2)
                    throw new AppError('INVALID_INPUT', 'Завершите проверку подготовленного объекта перед следующим.');
                await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{objectStagingBytes}',to_jsonb($2::bigint)) where id=$1", [id, size]);
            }
        });
    }
    remap(key: string, id: string) { recoveryPath(key); if (!/^private\/(artifacts|checkpoints|validation|catalog)\//.test(key))
        throw new AppError('INVALID_INPUT', 'Неизвестное пространство объектов.'); const parts = key.split('/'), prefix = parts[1] === 'validation' ? 3 : 4; return [...parts.slice(0, prefix), 'restore-' + id, ...parts.slice(prefix)].join('/'); }
    async finishObject(actor: Principal, id: string, seq: number) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 1000000)
            throw new AppError('INVALID_INPUT', 'Неверный номер записи.');
        const staged = await this.repository.transaction(async (tx) => {
            const s = await this.snapshot(actor, id, tx);
            if (s.data.kind !== 'restore')
                throw new AppError('CONFLICT', 'Не сеанс восстановления.');
            return { verified: (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, 4000000000 + seq])).rows[0]?.data, file: (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=$2', [id, seq])).rows[0]?.data as RecoveryRecord, chunks: (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 order by seq', [id, 1000000000 + seq * 2000, 1000000000 + (seq + 1) * 2000])).rows.map(r => r.data) };
        });
        if (staged.file?.type !== 'file')
            throw new AppError('NOT_FOUND', 'Нет объекта.');
        const file = staged.file;
        if (staged.verified) {
            if (staged.verified.source !== file.path || staged.verified.sha256 !== file.sha256 || staged.verified.size !== file.size)
                throw new AppError('CONFLICT', 'Проверенный объект изменился.');
            return { ok: true };
        }
        let size = 0;
        const buffers: Buffer[] = [];
        for (const [index, chunk] of staged.chunks.entries()) {
            if (chunk.index !== index)
                throw new AppError('INVALID_INPUT', 'Часть объекта отсутствует.');
            const bytes = Buffer.from(chunk.base64, 'base64');
            size += bytes.length;
            if (size > file.size)
                throw new AppError('INVALID_INPUT', 'Размер объекта превышен.');
            buffers.push(bytes);
        }
        const bytes = Buffer.concat(buffers);
        if (size !== file.size || sha(bytes) !== file.sha256)
            throw new AppError('INVALID_INPUT', 'Хэш объекта не совпадает.');
        if (file.root === 'object' && file.path.startsWith('private/validation/'))
            verifyValidationPng(bytes);
        const key = file.root === 'catalog' ? 'private/catalog/restored/' + id + '/' + file.path : this.remap(file.path, id);
        try {
            await this.store.transport.put(key, bytes, file.mediaType);
        }
        catch {
            const existing = await this.store.transport.get(key, file.size);
            if (sha(existing) !== file.sha256)
                throw new AppError('CONFLICT', 'Подготовленный объект изменился.');
        }
        await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); await tx.query('insert into private.recovery_snapshot_records values($1,$2,$3) on conflict do nothing', [id, 4000000000 + seq, { type: 'verified', source: file.path, key, size: file.size, sha256: file.sha256,sha1:createHash('sha1').update(bytes).digest('hex'),mediaType:file.mediaType }]); const removed = await tx.query("with removed as (delete from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 returning octet_length(decode(data->>'base64','base64')) size) select coalesce(sum(size),0) released from removed", [id, 1000000000 + seq * 2000, 1000000000 + (seq + 1) * 2000]), released = Number(removed.rows[0].released); await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{objectStagingBytes}',to_jsonb(greatest(0,coalesce((data->>'objectStagingBytes')::bigint,0)-$2::bigint))) where id=$1", [id, released]); });
        return { ok: true };
    }
    async install(actor:Principal,id:string):Promise<RestoreReport>{
        const transfer=new PostgresRecoveryTransfer(this);
        for(;;){const progress=await transfer.prepareBatch(actor,id);if(progress.phase==='ready'||progress.phase==='committed')return transfer.commitPrepared(actor,id);}
    }
    async verifyCatalog(files: {
        path: string;
        key: string;
        size: number;
        sha256: string;
    }[]) { const index = files.find(f => f.path === 'templates/catalog.json'), reference = files.find(f => f.path === 'references/catalog.json'); if (!index || !reference || index.size > 200000 || reference.size > 2000000)
        throw new AppError('INVALID_INPUT', 'Опись материалов отсутствует.'); const read = async (f: typeof index) => { const bytes = await this.store.transport.get(f.key, f.size,AbortSignal.timeout(20000)); if (bytes.length !== f.size || sha(bytes) !== f.sha256)
        throw new AppError('INVALID_INPUT', 'Опись материалов повреждена.'); return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }, styles = await read(index), references = await read(reference); if (!Array.isArray(styles) || styles.length > 1000 || !Array.isArray(references) || references.length > 10000)
        throw new AppError('INVALID_INPUT', 'Неверная опись материалов.'); return styles.map(s => { if (typeof s.id !== 'string' || !/^[a-z][a-z-]+$/.test(s.id) || typeof s.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(s.version) || !Array.isArray(s.files) || !s.files.length || s.files.length > 100 || s.files.some((p: unknown) => typeof p !== 'string' || !files.some(f => f.path === 'templates/' + s.id + '/' + artifactPath(p))) || !Array.isArray(s.referenceIds) || s.referenceIds.some((id: unknown) => !references.some(r => r.id === id)))
        throw new AppError('INVALID_INPUT', 'Файлы версии или референсы отсутствуют.'); return s.id + '@' + s.version; }); }
}
