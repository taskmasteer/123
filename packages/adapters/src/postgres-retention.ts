import { materializePostgres, preflightPostgres } from './retention-sql.js';import { randomUUID } from 'node:crypto';
import type { CheckpointProjection, PayloadInventory, PayloadRef } from '../../contracts/src/recovery.js';
import type { SqlTransaction } from './supabase-repository.js';
import { AppError } from '../../contracts/src/model.js';
import { SupabaseRepository } from './supabase-repository.js';
import type { ObjectTransport } from './r2-store.js';
import { projectCheckpoint } from '../../core/src/usage.js';
export async function assertPostgresPayload(tx: Pick<SqlTransaction, 'query'>, ref: PayloadRef) { await tx.query('select private.assert_payload($1,$2)', [ref.kind, ref.id]); }
export async function retainedPublicationRevision(tx: Pick<SqlTransaction, 'query'>, siteId: string, revisionId: string) { return !!(await tx.query("with settled as (select p.*,row_number() over(order by settled_seq desc nulls last,verified_at desc,id desc) n from private.provider_publications p where site_id=$1 and settlement='settled' and verified_at is not null),current_outcome as (select id from settled where revision_id=(select published_id from public.sites where id=$1) order by n limit 1),kept as (select *,row_number() over(order by (id=(select id from current_outcome)) desc nulls last,n) keep_n from settled),boundary as (select verified_at from kept where keep_n=6 and settled_seq is null) select 1 from kept where revision_id=$2 and (keep_n<=6 or (settled_seq is null and verified_at=(select verified_at from boundary))) limit 1", [siteId, revisionId])).rowCount; }
export async function registerPostgresPayload(tx: SqlTransaction, payload: PayloadInventory) {
    await assertPostgresPayload(tx, payload);
    const old = (await tx.query('select data from private.payload_inventory where kind=$1 and id=$2 for update', [payload.kind, payload.id])).rows[0];
    if (old) {
        if (old.data.objects.length !== payload.objects.length || payload.objects.some((o, i) => ['key', 'size', 'sha256', 'mediaType'].some(k => old.data.objects[i][k] !== o[k as keyof typeof o])))
            throw new AppError('CONFLICT', 'Неизменяемый состав содержимого.');
        await tx.query('update private.payload_inventory set state=$3 where kind=$1 and id=$2', [payload.kind, payload.id, payload.state]);
    }
    else
        await tx.query('insert into private.payload_inventory values($1,$2,$3,$4,$5,null,null)', [payload.kind, payload.id, payload.siteId, payload, payload.state]);
}
export async function commitPostgresProjection(tx: SqlTransaction, projection: CheckpointProjection, latest = true, authority?: {
    workerId: string;
    generation: number;
}) {
    const e = projection.evidence, old = (await tx.query('select data from private.checkpoint_evidence where id=$1', [e.checkpoint.id])).rows[0];
    const binding = (await tx.query('select job_id,site_id from private.checkpoints where id=$1', [e.checkpoint.id])).rows[0];
    if (!binding || binding.job_id !== e.checkpoint.jobId || binding.site_id !== e.state.siteId)
        throw new AppError('INVALID_INPUT', 'Проекция принадлежит другому заданию.');
    if (old && old.data.digest !== e.digest)
        throw new AppError('CONFLICT', 'Неизменяемое свидетельство проверки.');
    await tx.query('insert into private.checkpoint_evidence values($1,$2,$3) on conflict do nothing', [e.checkpoint.id, e.checkpoint.jobId, e]);
    await tx.query("update private.payload_inventory set data=data||'{\"accepted\":true}'::jsonb where kind='checkpoint' and id=$1", [e.checkpoint.id]);
    if (latest)
        await tx.query('insert into private.job_usage values($1,$2,$3) on conflict(job_id) do update set checkpoint_id=excluded.checkpoint_id,data=excluded.data', [e.checkpoint.jobId, e.checkpoint.id, projection.usage]);
    for (const purpose of ['execution', 'retained'] as const)
        for (const ref of projection[purpose]) {
            await assertPostgresPayload(tx, ref);
            if (ref.kind === 'artifact' && !(await tx.query('select 1 from private.artifacts where id::text=$1 and site_id=$2 and verified', [ref.id, e.state.siteId])).rowCount)
                throw new AppError('INVALID_INPUT', 'Артефакт зависимости другого сайта.');
            if (ref.kind === 'checkpoint' && !(await tx.query('select 1 from private.checkpoints where id::text=$1 and job_id=$2 and site_id=$3', [ref.id, e.checkpoint.jobId, e.state.siteId])).rowCount)
                throw new AppError('INVALID_INPUT', 'Восстановление другого задания.');
            if (ref.kind === 'screenshot' && !(await tx.query("select 1 from private.payload_inventory where kind='screenshot' and id=$1 and site_id=$2 and state='available' and data#>>'{producer,jobId}'=$3", [ref.id, e.state.siteId, e.checkpoint.jobId])).rowCount)
                throw new AppError('INVALID_INPUT', 'Снимок проверки не привязан к заданию.');
            if (ref.kind === 'screenshot' && authority && !(await tx.query("select 1 from private.payload_inventory p where p.kind='screenshot' and p.id=$1 and ((p.data#>>'{producer,workerId}'=$2 and (p.data#>>'{producer,generation}')::bigint=$3) or exists(select 1 from private.payload_edges x join private.checkpoint_evidence c on c.id::text=x.owner_id where x.owner_kind='checkpoint' and x.target_kind='screenshot' and x.target_id=p.id and c.job_id=$4))", [ref.id, authority.workerId, authority.generation, e.checkpoint.jobId])).rowCount)
                throw new AppError('STALE_LEASE', 'Снимок другого поколения без принятого свидетельства.');
            await tx.query('insert into private.payload_edges values($1,$2,$3,$4,$5) on conflict do nothing', ['checkpoint', e.checkpoint.id, purpose, ref.kind, ref.id]);
        }
}
export const payloadPinId = () => randomUUID();
export class PostgresRetention {
    constructor(readonly repository: SupabaseRepository, readonly transport: ObjectTransport) { }
    async maintain(store: import('../../contracts/src/model.js').CheckpointStore, now = Date.now()) { const run = await this.repository.transaction(async (tx) => { if ((await tx.query("select 1 from private.recovery_state where key='quarantine'")).rowCount)
        return false; return !!(await tx.query("insert into private.recovery_state values('retention-maintenance',jsonb_build_object('at',$1::bigint)) on conflict(key) do update set data=excluded.data where (private.recovery_state.data->>'at')::bigint<$1-3600000 returning key", [now])).rowCount; }); if (run) {
        await this.backfill(store, false);
        await this.collect(now);
    } }
    async backfill(store: import('../../contracts/src/model.js').CheckpointStore, strict = true) {
        await this.repository.transaction(async (tx) => { await tx.query("set local statement_timeout='15s';set local work_mem='4MB'"); await preflightPostgres(tx); });
        await this.repository.transaction(async (tx) => {
            await tx.query(`with recursive accepted(id) as (select checkpoint_id from private.jobs where checkpoint_id is not null union select c.expected_checkpoint_id from private.checkpoints c join accepted a on a.id=c.id where c.expected_checkpoint_id is not null), source as (
    select 'artifact'::text kind,a.id,a.site_id,a.manifest metadata,null::uuid job_id,null::uuid worker_id,null::bigint generation,false accepted,'available'::text state from private.artifacts a where a.verified
    union all select 'checkpoint',c.id,c.site_id,c.metadata,c.job_id,c.worker_id,c.generation,exists(select 1 from accepted a where a.id=c.id),'available' from private.checkpoints c union all select case when u.purpose='artifact' then 'artifact' else 'checkpoint' end,u.id,u.site_id,case when u.purpose='artifact' then u.metadata->'manifest' else u.metadata end,u.job_id,u.worker_id,u.generation,false,'staging' from private.upload_preparations u where u.completed_at is null and u.purpose in ('artifact','checkpoint')), inventory as (
    select kind,id::text id,site_id,jsonb_build_object('kind',kind,'id',id::text,'siteId',site_id,'accepted',accepted,'createdAt',coalesce((case when kind='artifact' then metadata->>'createdAt' else metadata#>>'{checkpoint,createdAt}' end)::bigint,0),'protectUntil',0,'state',state,'firstOrphanAt',null,'claimToken',null,'producer',case when job_id is null then null else jsonb_build_object('jobId',job_id,'workerId',worker_id,'generation',generation) end,'objects',(select coalesce(jsonb_agg(jsonb_build_object('key',f->>'objectKey','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType')),'[]'::jsonb) from jsonb_array_elements(case when kind='artifact' then metadata->'files' else (metadata#>'{manifest,files}')||jsonb_build_array(metadata->'state') end) f)) data,state from source)
    insert into private.payload_inventory select kind,id,site_id,data,state,null,null from inventory on conflict do nothing`);
            await tx.query(`insert into private.payload_inventory select 'resource',r.id::text,null,jsonb_build_object('kind','resource','id',r.id::text,'siteId',null,'createdAt',$1::bigint,'protectUntil',$1::bigint+600000,'state',case when (r.data->>'complete')::boolean then 'available' else 'staging' end,'firstOrphanAt',null,'claimToken',null,'objects',jsonb_build_array(jsonb_build_object('key','database:private.import_chunks:'||r.id::text,'size',r.data->'size','sha256',r.data->'sha256','mediaType',case when r.data->>'draftId' is null then 'application/octet-stream' else 'image/png' end))),case when (r.data->>'complete')::boolean then 'available' else 'staging' end,null,null from private.import_resources r on conflict do nothing`, [Date.now()]);
        });
        let after: string | null = null;
        for (;;) {
            const rows: {
                id: string;
                job_id: string;
                site_id: string;
                expected_checkpoint_id: string | null;
            }[] = (await this.repository.pool.query("select c.id,c.job_id,c.site_id,c.expected_checkpoint_id from private.checkpoints c join private.payload_inventory p on p.kind='checkpoint' and p.id=c.id::text left join private.checkpoint_evidence e on e.id=c.id where e.id is null and p.data->>'accepted'='true' and p.state='available' and ($1::uuid is null or c.id>$1) order by c.id limit 64", [after])).rows;
            if (!rows.length)
                break;
            after = rows[rows.length - 1]!.id;
            for (const row of rows) {
                try {
                    const loaded = await store.load(row.id), projection = projectCheckpoint(loaded.checkpoint, loaded.state, loaded.files, row.expected_checkpoint_id);
                    await this.repository.transaction(async (tx) => {
                        await tx.query('select id from public.sites where id=$1 for update', [row.site_id]);
                        const current = (await tx.query('select checkpoint_id from private.jobs where id=$1 for update', [row.job_id])).rows[0];
                        if (!current)
                            return;
                        const accepted = (await tx.query('with recursive chain(id) as (select $1::uuid union select c.expected_checkpoint_id from private.checkpoints c join chain a on a.id=c.id where c.expected_checkpoint_id is not null) select 1 from chain where id=$2', [current.checkpoint_id, row.id])).rowCount;
                        if (accepted)
                            await commitPostgresProjection(tx, projection, current.checkpoint_id === row.id);
                    });
                    await this.repository.transaction(tx => tx.query('delete from private.recovery_state where key=$1', ['legacy-coverage:checkpoint:' + row.id]));
                }
                catch (error) {
                    await this.repository.transaction(tx => tx.query('insert into private.recovery_state values($1,$2) on conflict(key) do update set data=excluded.data', ['legacy-coverage:checkpoint:' + row.id, { coverage: 'unavailable', payload: 'checkpoint:' + row.id, siteId: row.site_id, observedAt: Date.now() }]));
                    if (strict)
                        throw new AppError('NEEDS_ATTENTION', 'Полная копия недоступна: исторические контрольные точки или снимки требуют проверенного восстановления.', { cause: error });
                }
            }
        }
    }
    async closure(tx: SqlTransaction, now: number, checked = false) { await materializePostgres(tx, now, checked); }
    private async candidates(tx: SqlTransaction, now: number) { await this.closure(tx, now); await tx.query("create temp table retention_eligible(kind text,id text,primary key(kind,id)) on commit drop"); await tx.query("insert into retention_eligible select p.kind,p.id from private.payload_inventory p left join retention_protected r on r.kind=p.kind and r.id=p.id left join retention_unknown u on u.site_id=p.site_id::text left join retention_evidence e on e.id=p.id where p.state in ('available','staging') and r.id is null and u.site_id is null and coalesce((p.data->>'protectUntil')::bigint,0)<=$1 and not (p.kind='checkpoint' and coalesce((p.data->>'accepted')::boolean,true) and ((p.data->>'createdAt')::bigint+2592000000>$1 or e.id is null))", [now]); await tx.query('analyze retention_eligible'); await tx.query("update private.payload_inventory p set first_orphan_at=null where state in ('available','staging') and first_orphan_at is not null and not exists(select 1 from retention_eligible e where e.kind=p.kind and e.id=p.id)"); await tx.query("insert into retention_candidates select kind,id from private.payload_inventory where state='claimed' union select p.kind,p.id from private.payload_inventory p join retention_eligible e using(kind,id) where p.first_orphan_at is not null and p.first_orphan_at+86400000<=$1", [now]); await tx.query("update private.payload_inventory p set first_orphan_at=$1 from retention_eligible e where p.kind=e.kind and p.id=e.id and p.first_orphan_at is null", [now]); }
    async planCleanup(now: number) { return this.repository.transaction(async (tx) => { await this.candidates(tx, now); return { deletableManifestIds: (await tx.query("select id from retention_candidates where kind='artifact' order by id")).rows.map(r => String(r.id)) }; }, 'exclusive'); }
    async collect(now: number) {
        if (!this.transport.delete)
            throw new AppError('UNAVAILABLE', 'Удаление объектов не подключено.');
        const token = randomUUID();
        await this.repository.transaction(async (tx) => { await this.candidates(tx, now); await tx.query("update private.payload_inventory p set state='claimed',claim_token=$1 where state<>'claimed' and exists(select 1 from retention_candidates c where c.kind=p.kind and c.id=p.id)", [token]); }, 'exclusive');
        let kind = '', id = '';
        while (true) {
            const page = (await this.repository.pool.query("select * from private.payload_inventory where state='claimed' and (kind,id)>($1,$2) order by kind,id limit 64", [kind, id])).rows;
            if (!page.length)
                break;
            for (const row of page) {
                kind = row.kind;
                id = row.id;
                const p = row.data as PayloadInventory;
                if (row.kind !== 'resource')
                    for (const object of p.objects)
                        await this.transport.delete(object.key);
            }
            const done = page.map(row => ({ kind: row.kind, id: row.id, token: row.claim_token }));
            await this.repository.transaction(async (tx) => { await tx.query("delete from private.import_chunks where resource_id::text in(select id from jsonb_to_recordset($1::jsonb) as d(kind text,id text,token uuid) where kind='resource')", [JSON.stringify(done)]); await tx.query("update private.payload_inventory p set state='deleted' from jsonb_to_recordset($1::jsonb) as d(kind text,id text,token uuid) where p.kind=d.kind and p.id=d.id and p.state='claimed' and p.claim_token=d.token", [JSON.stringify(done)]); });
        }
    }
}
