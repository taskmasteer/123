import type { DatabaseSync } from 'node:sqlite';
import type { PayloadRef, PayloadInventory, CheckpointProjection } from '../../contracts/src/recovery.js';
import { AppError } from '../../contracts/src/model.js';
/** All functions here are synchronous and run on the controller's already owned DB. */
export function initializeRecovery(sql: DatabaseSync) {
    sql.exec('pragma temp_store=FILE;pragma cache_size=-4096;');
    sql.exec(`create table if not exists payload_inventory(kind text not null,id text not null,site_id text,data text not null,state text not null,first_orphan_at integer,claim_token text,primary key(kind,id)) strict;
 create table if not exists payload_edges(owner_kind text not null,owner_id text not null,purpose text not null,target_kind text not null,target_id text not null,primary key(owner_kind,owner_id,purpose,target_kind,target_id)) strict;
 create table if not exists checkpoint_evidence(id text primary key,job_id text not null,data text not null) strict;
 create table if not exists job_usage(job_id text primary key,checkpoint_id text not null,data text not null) strict;
 create table if not exists payload_pins(id text not null,kind text not null,payload_id text not null,expires_at integer not null,primary key(id,kind,payload_id)) strict;
 create table if not exists recovery_state(key text primary key,data text not null) strict;
 create table if not exists recovery_snapshots(id text primary key,actor_id text not null,expires_at integer not null,data text not null) strict;
 create table if not exists recovery_snapshot_records(snapshot_id text not null,seq integer not null,data text not null,primary key(snapshot_id,seq)) strict;
 create table if not exists publication_outcomes(id text primary key,site_id text not null,data text not null) strict;`);
    for (const table of ['checkpoint_evidence', 'publication_outcomes'])
        for (const action of ['update', 'delete'])
            sql.exec(`create trigger if not exists immutable_${table}_${action} before ${action} on ${table} begin select raise(abort,'Immutable recovery evidence'); end;`);
    sql.exec(`create trigger if not exists immutable_payload_objects before update on payload_inventory when (old.state in ('claimed','deleted') and new.state not in ('claimed','deleted')) or new.kind!=old.kind or new.id!=old.id or json_extract(new.data,'$.objects') is not json_extract(old.data,'$.objects') begin select raise(abort,'Immutable payload composition'); end;`);
    sql.function('assert_payload', (kind, id) => {
        if (typeof id === 'string')
            assertLocalPayload(sql, { kind: String(kind) as PayloadRef['kind'], id });
        return 1;
    });
    sql.function('assert_recovery_mutable', () => {
        if (sql.prepare("select 1 from recovery_state where key='quarantine'").get())
            throw new AppError('CONFLICT', 'Восстановленная установка ожидает сверки.');
        return 1;
    });
    for (const table of ['sites', 'jobs', 'records', 'batches', 'batch_rows', 'resources', 'chunks', 'operations'])
        for (const action of ['insert', 'update', 'delete'])
            sql.exec(`create trigger if not exists recovery_gate_${table}_${action} before ${action} on ${table} begin select assert_recovery_mutable(); end;`);
    for (const action of ['insert', 'update']) {
        sql.exec(`create trigger if not exists payload_batch_rows_${action} before ${action} on batch_rows begin select assert_payload('resource',json_extract(new.data,'$.input.logoAssetId')); end;
   create trigger if not exists payload_chunks_${action} before ${action} on chunks begin select assert_payload('resource',new.resource_id); end;`);
        sql.exec(`create trigger if not exists payload_sites_${action} before ${action} on sites begin
   select assert_payload('artifact',json_extract(r.data,'$.manifestId')) from records r where r.kind='revisions' and r.id in (json_extract(new.data,'$.draftId'),json_extract(new.data,'$.publishedId'));
   select assert_payload('resource',json_extract(new.data,'$.input.logoAssetId')); end;`);
        sql.exec(`create trigger if not exists payload_jobs_${action} before ${action} on jobs when new.state not in ('completed','cancelled') begin
   select assert_payload('checkpoint',json_extract(new.data,'$.checkpointId'));
   select assert_payload('artifact',json_extract(new.data,'$.edit.baseManifestId'));
   select assert_payload('checkpoint',json_extract(new.data,'$.providerRecovery.checkpointId')); end;`);
        sql.exec(`create trigger if not exists payload_records_${action} before ${action} on records when new.kind in ('revisions','publications','candidates') begin
   select assert_payload('artifact',json_extract(new.data,'$.manifestId')) where new.kind='revisions' or json_extract(new.data,'$.state')='pending' or json_extract(new.data,'$.status') in ('queued','running','checking','ready'); end;`);
    }
}
export function assertLocalPayload(sql: DatabaseSync, ref: PayloadRef) { const row = sql.prepare('select state from payload_inventory where kind=? and id=?').get(ref.kind, ref.id); if (row && ['claimed', 'deleted'].includes(String(row.state)))
    throw new AppError('CONFLICT', 'Содержимое версии уже очищено.'); }
export function registerLocalPayload(sql: DatabaseSync, payload: PayloadInventory) {
    const old = sql.prepare('select data,state from payload_inventory where kind=? and id=?').get(payload.kind, payload.id);
    if (old) {
        assertLocalPayload(sql, payload);
        const p = JSON.parse(String(old.data)) as PayloadInventory;
        if (JSON.stringify(p.objects) !== JSON.stringify(payload.objects))
            throw new AppError('CONFLICT', 'Неизменяемый состав содержимого.');
        sql.prepare('update payload_inventory set state=? where kind=? and id=?').run(payload.state, payload.kind, payload.id);
        return;
    }
    sql.prepare('insert into payload_inventory values(?,?,?,?,?,?,?)').run(payload.kind, payload.id, payload.siteId, JSON.stringify(payload), payload.state, payload.firstOrphanAt, payload.claimToken);
}
export function commitLocalProjection(sql: DatabaseSync, projection: CheckpointProjection, latest = true, authority?: {
    workerId: string;
    generation: number;
}) {
    const e = projection.evidence, old = sql.prepare('select data from checkpoint_evidence where id=?').get(e.checkpoint.id);
    const binding = sql.prepare('select site_id from jobs where id=?').get(e.checkpoint.jobId);
    if (!binding || binding.site_id !== e.state.siteId)
        throw new AppError('INVALID_INPUT', 'Проекция принадлежит другому заданию.');
    if (old && JSON.parse(String(old.data)).digest !== e.digest)
        throw new AppError('CONFLICT', 'Неизменяемое свидетельство проверки.');
    sql.prepare('insert or ignore into checkpoint_evidence values(?,?,?)').run(e.checkpoint.id, e.checkpoint.jobId, JSON.stringify(e));
    sql.prepare("update payload_inventory set data=json_set(data,'$.accepted',json('true')) where kind='checkpoint' and id=?").run(e.checkpoint.id);
    if (latest)
        sql.prepare('insert into job_usage values(?,?,?) on conflict(job_id) do update set checkpoint_id=excluded.checkpoint_id,data=excluded.data').run(e.checkpoint.jobId, e.checkpoint.id, JSON.stringify(projection.usage));
    for (const purpose of ['execution', 'retained'] as const)
        for (const ref of projection[purpose]) {
            assertLocalPayload(sql, ref);
            const payload = sql.prepare('select site_id,data,state from payload_inventory where kind=? and id=?').get(ref.kind, ref.id);
            if (payload && ref.kind !== 'catalog' && payload.site_id !== null && payload.site_id !== e.state.siteId)
                throw new AppError('INVALID_INPUT', 'Зависимость другого сайта.');
            if (ref.kind === 'screenshot' && (!payload || payload.state !== 'available' || payload.site_id !== e.state.siteId || JSON.parse(String(payload.data)).producer?.jobId !== e.checkpoint.jobId))
                throw new AppError('INVALID_INPUT', 'Снимок проверки не привязан к заданию.');
            if (ref.kind === 'screenshot' && authority) {
                const producer = payload ? JSON.parse(String(payload.data)).producer : null, accepted = sql.prepare("select 1 from payload_edges x join checkpoint_evidence c on c.id=x.owner_id where x.owner_kind='checkpoint' and x.target_kind='screenshot' and x.target_id=? and c.job_id=? limit 1").get(ref.id, e.checkpoint.jobId);
                if ((producer?.workerId !== authority.workerId || producer?.generation !== authority.generation) && !accepted)
                    throw new AppError('STALE_LEASE', 'Снимок другого поколения без принятого свидетельства.');
            }
            if (ref.kind === 'checkpoint') {
                const owner = sql.prepare('select job_id from checkpoint_evidence where id=?').get(ref.id)?.job_id ?? (payload ? JSON.parse(String(payload.data)).producer?.jobId : undefined);
                if (owner !== undefined && owner !== e.checkpoint.jobId)
                    throw new AppError('INVALID_INPUT', 'Восстановление другого задания.');
            }
            sql.prepare('insert or ignore into payload_edges values(?,?,?,?,?)').run('checkpoint', e.checkpoint.id, purpose, ref.kind, ref.id);
        }
}
