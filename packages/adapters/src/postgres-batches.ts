import {batchDirection} from '../../core/src/generation-direction.js';
import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../contracts/src/model.js';
import type { Principal, Job } from '../../contracts/src/model.js';
import type { ImportRow, ImportRowView, ImportSummary } from '../../contracts/src/import.js';
import { importLimits } from '../../contracts/src/import.js';
import { validateRows } from '../../core/src/import/rows.js';
import { authorize } from '../../core/src/permissions.js';
import { object, uuid, string, integer } from '../../contracts/src/http.js';
import type { SupabaseRepository, SqlTransaction } from './supabase-repository.js';
interface Draft {
    summary: ImportSummary;
    hash: string;
    committedRevision?: number;
}
export class PostgresBatches {
    constructor(readonly repository: SupabaseRepository) { }
    async advance() {
        const selected = await this.repository.transaction(async (tx) => {
            const r = (await tx.query("select b.id,b.owner_id,m.role from private.batches b join public.memberships m on m.user_id=b.owner_id and m.active where b.state='active' and exists(select 1 from private.batch_rows r where r.batch_id=b.id and r.site_id is null and jsonb_array_length(r.data->'issues')=0) order by b.admission_selected_at nulls first,b.created_at,b.id for update of b skip locked limit 1")).rows[0];
            if (r)
                await tx.query('update private.batches set admission_selected_at=clock_timestamp() where id=$1', [r.id]);
            return r;
        });
        if (selected)
            await this.admit({ userId: selected.owner_id, role: selected.role }, selected.id, 25);
    }
    async read(tx: Pick<SqlTransaction, 'query'>, actor: Principal, id: string, manage = false, lock = false): Promise<Draft> {
        const row = (await tx.query('select b.*,exists(select 1 from private.batch_assignments a where a.batch_id=b.id and a.user_id=$2) assigned from private.batches b where id=$1' + (lock ? ' for update of b' : ''), [id, actor.userId])).rows[0];
        if (!row)
            throw new AppError('NOT_FOUND', 'Пачка не найдена.');
        if (actor.role !== 'admin' && row.owner_id !== actor.userId && (manage || !row.assigned))
            throw new AppError(manage ? 'FORBIDDEN' : 'NOT_FOUND', 'Нет доступа к пачке.');
        return row.data as Draft;
    }
    async rows(id: string, tx: Pick<SqlTransaction, 'query'> = this.repository.pool): Promise<ImportRowView[]> { return (await tx.query('select data from private.batch_rows where batch_id=$1 order by row_number', [id])).rows.map(r => r.data); }
    async putRow(tx: SqlTransaction, id: string, r: ImportRowView) { await tx.query('insert into private.batch_rows values($1,$2,$3,$4) on conflict(batch_id,row_number) do update set data=$3,site_id=$4', [id, r.rowNumber, r, r.siteId]); }
    async save(tx: SqlTransaction, d: Draft) { await tx.query('update private.batches set data=$2,state=$3 where id=$1', [d.summary.id, d, d.summary.state]); }
    async submitBatch(actor: Principal, inputs: ImportRow[], requestKey: string) {
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestKey) || inputs.length > 5000 || new Set(inputs.map(r => r.rowNumber)).size !== inputs.length)
            throw new AppError('INVALID_INPUT', 'Некорректная пачка.');
        const parsed = validateRows(structuredClone(inputs));
        const hash = createHash('sha256').update(JSON.stringify(parsed.rows.map(r => [r.rowNumber, r.domain, r.about ?? '', r.referenceId ?? '', r.layoutReferenceId ?? '', r.logo ?? '', r.logoAssetId ?? '', r.mentionedUrl ?? '', r.mentionedDescription ?? '']))).digest('hex');
        const batchId = await this.repository.transaction(async (tx) => {
            actor = await this.repository.fresh(tx, actor);
            authorize(actor, 'site:create');
            const proposed = randomUUID(), invalid = new Set(parsed.issues.map(i => i.rowNumber)).size, d: Draft = { summary: { id: proposed, name: 'Импорт', revision: 1, state: 'active', total: inputs.length, validCount: inputs.length - invalid, invalidCount: invalid, canControl: true }, hash };
            await tx.query('insert into private.batches(id,owner_id,state,data,request_key,payload_hash) values($1,$2,$3,$4,$5,$6) on conflict(owner_id,request_key) where request_key is not null do nothing', [proposed, actor.userId, 'active', d, requestKey, hash]);
            const old = (await tx.query('select id,payload_hash from private.batches where owner_id=$1 and request_key=$2 for update', [actor.userId, requestKey])).rows[0];
            if (old.payload_hash !== hash)
                throw new AppError('CONFLICT', 'Ключ запроса связан с другой пачкой.');
            return String(old.id);
        });
        for (let offset = 0; offset < parsed.rows.length; offset += 50)
            await this.repository.transaction(async (tx) => {
                actor = await this.repository.fresh(tx, actor);
                await this.read(tx, actor, batchId, true, true);
                for (const input of parsed.rows.slice(offset, offset + 50))
                    await tx.query('insert into private.batch_rows values($1,$2,$3,null) on conflict(batch_id,row_number) do nothing', [batchId, input.rowNumber, { rowNumber: input.rowNumber, input, issues: parsed.issues.filter(i => i.rowNumber === input.rowNumber), siteId: null, job: null }]);
            });
        await this.admit(actor, batchId);
        return { batchId, siteIds: (await this.rows(batchId)).flatMap(r => r.siteId ? [r.siteId] : []) };
    }
    async admit(actor: Principal, id: string, maximum = 5000) {
        const pending = (await this.repository.pool.query("select data from private.batch_rows where batch_id=$1 and site_id is null and jsonb_array_length(data->'issues')=0 order by row_number limit $2", [id, maximum])).rows.map(r => r.data as ImportRowView);
        for (const row of pending) {
            const more = await this.repository.transaction(async (tx) => {
                actor = await this.repository.fresh(tx, actor);
                const d = await this.read(tx, actor, id, true, true);
                if (d.summary.state !== 'active')
                    return false;
                const r = (await tx.query('select data from private.batch_rows where batch_id=$1 and row_number=$2 for update', [id, row.rowNumber])).rows[0].data as ImportRowView;
                if (r.siteId || r.issues.length)
                    return true;
                const owner = (await tx.query('select owner_id from private.batches where id=$1', [id])).rows[0].owner_id;
                if ((await tx.query('select id from public.sites where domain=$1', [r.input.domain])).rowCount)
                    r.issues = [{ rowNumber: r.rowNumber, column: 'domain', code: 'DUPLICATE_DOMAIN', message: 'Домен уже существует в реестре.' }];
                else {
                    // A hosting controller can defer admission until an IPv4 is
                    // available. No site, model job or partial allocation exists yet.
                    if(this.repository.canAdmitBatchSite&&!await this.repository.canAdmitBatchSite(tx))return false;
                    // The domain reservation, job, operation and row association commit together.
                    try {
                        const input = { domain: r.input.domain, ...(r.input.about ? { about: r.input.about } : {}), ...(r.input.referenceId ? { referenceId: r.input.referenceId } : {}), ...(r.input.layoutReferenceId ? {layoutReferenceId:r.input.layoutReferenceId} : {}), ...(r.input.logoAssetId ? { logoAssetId: r.input.logoAssetId } : {}), ...(r.input.mentionedUrl ? {mentionedUrl:r.input.mentionedUrl,mentionedDescription:r.input.mentionedDescription??''}:{}) };
                        const styles=(await tx.query("select data from private.catalog where kind='style' order by id")).rows.map(r=>r.data);
                        const generation=styles.length?batchDirection(styles,id,r.rowNumber,input.layoutReferenceId?'reference-'+input.layoutReferenceId:input.referenceId):undefined;
                        const site = await this.repository.insertSiteInTransaction(tx, input, { ...actor, userId: owner }, randomUUID(), id,generation);
                        r.siteId = site.id;
                    }
                    catch (error) {
                        if (!(error instanceof AppError && error.code === 'DUPLICATE_DOMAIN'))
                            throw error;
                        r.issues = [{ rowNumber: r.rowNumber, column: 'domain', code: 'DUPLICATE_DOMAIN', message: 'Домен уже существует в реестре.' }];
                    }
                }
                await this.putRow(tx, id, r);
                return true;
            });
            if (!more)
                break;
        }
    }
    async request(actor: Principal, method: string, value: unknown): Promise<unknown> {
        if(method==='batch.delete'){
            const p=object(value,['id','revision']),id=uuid(p.id);
            await this.repository.transaction(async tx=>{
                actor=await this.repository.fresh(tx,actor);
                const draft=await this.read(tx,actor,id,true,true);
                if(draft.summary.state!=='preview'||draft.summary.revision!==integer(p.revision))throw new AppError('CONFLICT','Удалить можно только незапущенную пачку. Обновите список.');
                if((await tx.query('select 1 from private.batch_rows where batch_id=$1 and site_id is not null',[id])).rowCount)throw new AppError('CONFLICT','В пачке уже есть созданные сайты.');
                await tx.query('delete from private.batch_assignments where batch_id=$1',[id]);
                await tx.query('delete from private.batch_rows where batch_id=$1',[id]);
                await tx.query('delete from private.batches where id=$1',[id]);
            });return {ok:true};
        }
        if (method === 'batch.list') {
            const p = object(value, ['cursor']);
            const cursor = p.cursor === undefined ? null : uuid(p.cursor);
            const rows = (await this.repository.pool.query("select b.id from private.batches b where b.state<>'uploading' and ($1='admin' or b.owner_id=$2 or exists(select 1 from private.batch_assignments a where a.batch_id=b.id and a.user_id=$2)) and ($3::uuid is null or b.id>$3) order by b.id limit 51", [actor.role, actor.userId, cursor])).rows;
            return { items: await Promise.all(rows.slice(0, 50).map(r => this.get(actor, r.id))), nextCursor: rows.length > 50 ? rows[49].id : null };
        }
        const p = object(value, method === 'batch.assign' ? ['id', 'userIds'] : method === 'batch.rows' ? ['id', 'cursor', 'status'] : ['id']), id = uuid(p.id);
        if (method === 'batch.get')
            return this.get(actor, id);
        if (method === 'batch.rows') {
            await this.read(this.repository.pool, actor, id);
            const cursor = p.cursor === undefined ? 0 : integer(Number(p.cursor), 0, 5001), status = p.status ?? 'all';
            if (!['all', 'valid', 'invalid'].includes(String(status)))
                throw new AppError('INVALID_INPUT', 'Некорректный фильтр строк.');
            const records = (await this.repository.pool.query(`select r.data,j.data job from private.batch_rows r left join private.jobs j on j.id=r.site_id where r.batch_id=$1 and r.row_number>$2 and ($3='all' or ($3='invalid' and (jsonb_array_length(r.data->'issues')>0 or j.data->>'state'='needs_attention')) or ($3='valid' and jsonb_array_length(r.data->'issues')=0 and coalesce(j.data->>'state','')<>'needs_attention')) order by r.row_number limit $4`, [id, cursor, status, importLimits.pageRows + 1])).rows;
            const items = records.slice(0, importLimits.pageRows).map(r => ({ ...r.data, job: r.job ? { id: r.job.id, state: r.job.state, stage: r.job.stage } : null }));
            return { items, nextCursor: records.length > importLimits.pageRows ? String(items.at(-1)!.rowNumber) : null };
        }
        await this.repository.transaction(async (tx) => {
            actor = await this.repository.fresh(tx, actor);
            if (method === 'batch.assign') {
                authorize(actor, 'admin:manage');
                await this.read(tx, actor, id, true, true);
                if (!Array.isArray(p.userIds) || p.userIds.length > 100)
                    throw new AppError('INVALID_INPUT', 'Не более 100 пользователей.');
                const ids = [...new Set(p.userIds.map(uuid))];
                if (Number((await tx.query('select count(*) n from public.memberships where user_id=any($1::uuid[]) and active', [ids])).rows[0].n) !== ids.length)
                    throw new AppError('INVALID_INPUT', 'Пользователь неактивен.');
                await tx.query('delete from private.batch_assignments where batch_id=$1', [id]);
                for (const userId of ids)
                    await tx.query('insert into private.batch_assignments values($1,$2)', [id, userId]);
                return;
            }
            // Match existing queue lock order; publication reservations are never deleted here.
            const ids = (await tx.query('select site_id from private.jobs where batch_id=$1 order by site_id,id', [id])).rows.map(r => r.site_id);
            await tx.query('select id from public.sites where id=any($1::uuid[]) order by id for update', [ids]);
            const workers = (await tx.query('select distinct coalesce(worker_id,last_worker_id) id from private.jobs where batch_id=$1', [id])).rows.map(r => r.id).filter(Boolean);
            await tx.query('select id from private.workers where id=any($1::uuid[]) order by id for update', [workers]);
            await tx.query('select id from private.jobs where batch_id=$1 order by site_id,id for update', [id]);
            await tx.query('select site_id from private.site_operations where site_id=any($1::uuid[]) order by site_id for update', [ids]);
            const d = await this.read(tx, actor, id, true, true);
            if (method === 'batch.pause') {
                if (d.summary.state !== 'active')
                    throw new AppError('CONFLICT', 'Пачка не запущена.');
                d.summary.state = 'paused';
                await tx.query("update private.jobs set pause_requested=true where batch_id=$1 and data->>'state' not in ('completed','cancelled')", [id]);
            }
            else if (method === 'batch.resume') {
                if (d.summary.state !== 'paused')
                    throw new AppError('CONFLICT', 'Пачка не приостановлена.');
                d.summary.state = 'active';
                await tx.query("update private.jobs set pause_requested=false,data=case when data->>'state'='paused' then jsonb_set(data,'{state}','\"queued\"') else data end where batch_id=$1", [id]);
            }
            else if (method === 'batch.cancel') {
                d.summary.state = 'cancelled';
                await tx.query("update private.jobs set data=jsonb_set(data,'{state}','\"cancelled\"'),pause_requested=true,generation=generation+1,worker_id=null,expires_at=null where batch_id=$1 and data->>'state' not in ('completed','cancelled')", [id]);
                await tx.query("delete from private.site_operations o using private.jobs j where j.batch_id=$1 and o.site_id=j.site_id and o.operation_id=j.id and o.kind='job'", [id]);
            }
            else
                throw new AppError('INVALID_INPUT', 'Неизвестная операция пачки.');
            await this.save(tx, d);
        });
        if (method === 'batch.resume')
            await this.admit(actor, id, 25);
        return { ok: true };
    }
    async get(actor: Principal, id: string) {
        const d=await this.read(this.repository.pool,actor,id),owner=(await this.repository.pool.query('select owner_id from private.batches where id=$1',[id])).rows[0].owner_id;
        const counts=(await this.repository.pool.query("select count(*) filter(where jsonb_array_length(r.data->'issues')>0 or j.data->>'state'='needs_attention') n, coalesce(bool_or((r.site_id is null and jsonb_array_length(r.data->'issues')=0) or j.data->>'state' in ('queued','running')),false) active from private.batch_rows r left join private.jobs j on j.id=r.site_id where r.batch_id=$1",[id])).rows[0],invalidCount=Number(counts.n);
        return {...d.summary,...(actor.role==='admin'?{assignedUserIds:(await this.repository.pool.query('select user_id from private.batch_assignments where batch_id=$1 order by user_id',[id])).rows.map(r=>r.user_id as string)}:{}),invalidCount,validCount:d.summary.total-invalidCount,activeWork:d.summary.state==='active'&&counts.active===true,canControl:actor.role==='admin'||actor.userId===owner};
    }
}
