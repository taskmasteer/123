import type { DatabaseSync } from 'node:sqlite';
import type { SqlTransaction } from './supabase-repository.js';
import { AppError } from '../../contracts/src/model.js';
import { localRecoveryTables, managedRecoveryTables } from './recovery-records.js';
export const retentionRecordLimit = 1000000, retentionByteLimit = 768 * 1024 ** 2;
const fail = () => new AppError('NEEDS_ATTENTION', 'Опись превышает проверенную ёмкость обработки: 1000000 записей / 768 МиБ.');
/** Only DB scalar relations cross this seam. No application JSON/graph hydration. */
export async function preflightPostgres(tx: Pick<SqlTransaction, 'query'>, snapshot = false) {
    let count = 0, bytes = 0;
    for (const table of managedRecoveryTables) {
        const r = (await tx.query('select count(*) n,coalesce(sum(octet_length(to_jsonb(t)::text)+80),0) bytes,coalesce(max(octet_length(to_jsonb(t)::text)+80),0) member from ' + table + ' t')).rows[0];
        count += Number(r.n);
        bytes += Number(r.bytes);
        if (count > retentionRecordLimit || bytes > retentionByteLimit || Number(r.member) > 1000000)
            throw fail();
    }
    const pins = (await tx.query("select count(*) n,coalesce(sum(octet_length(to_jsonb(p)::text)+80),0) bytes from private.payload_pins p where expires_at>clock_timestamp()")).rows[0];
    if (count + Number(pins.n) > retentionRecordLimit || bytes + Number(pins.bytes) > retentionByteLimit)
        throw fail();
    if (snapshot) {
        const r = (await tx.query("select coalesce(sum(n),0) n from (select jsonb_array_length(manifest->'files') n from private.artifacts a left join private.payload_inventory p on p.kind='artifact' and p.id=a.id::text where a.verified and coalesce(p.state,'available')='available' union all select jsonb_array_length(metadata#>'{manifest,files}')+1 from private.checkpoints c left join private.payload_inventory p on p.kind='checkpoint' and p.id=c.id::text where coalesce(p.state,'available')='available' union all select jsonb_array_length(data->'objects') from private.payload_inventory where kind in ('screenshot','catalog') and state='available') physical")).rows[0];
        if (count + Number(r.n) + 1 > retentionRecordLimit)
            throw fail();
    }
    return { count, bytes };
}
export function preflightLocal(sql: DatabaseSync, snapshot = false) {
    let count = 0, bytes = 0;
    for (const table of localRecoveryTables) {
        const columns = sql.prepare('pragma table_info(' + table + ')').all().map(r => String(r.name));
        const expression = table === 'chunks' ? "(length(bytes)*4/3+200)" : "length(cast(json_object(" + columns.flatMap(c => ["'" + c + "'", c]).join(',') + ") as blob))+80";
        const r = sql.prepare('select count(*) n,coalesce(sum(' + expression + '),0) bytes,coalesce(max(' + expression + '),0) member from ' + table).get()!;
        count += Number(r.n);
        bytes += Number(r.bytes);
        if (count > retentionRecordLimit || bytes > retentionByteLimit || Number(r.member) > 1000000)
            throw fail();
    }
    const pins = sql.prepare("select count(*) n,coalesce(sum(length(cast(json_object('id',id,'kind',kind,'payload_id',payload_id,'expires_at',expires_at) as blob))+80),0) bytes from payload_pins where expires_at>?").get(Date.now())!;
    if (count + Number(pins.n) > retentionRecordLimit || bytes + Number(pins.bytes) > retentionByteLimit)
        throw fail();
    if (snapshot) {
        const files = Number(sql.prepare("select coalesce(sum(json_array_length(data,'$.objects')+case when kind='artifact' then 1 else 0 end),0) n from payload_inventory where state='available' and kind<>'resource'").get()!.n);
        if (count + files + 1 > retentionRecordLimit)
            throw fail();
    }
    return { count, bytes };
}
function relations(pg: boolean, selected = false) {
    const j = (v: string, path: string) => pg ? v + "#>>'{" + path.split('.').join(',') + "}'" : "json_extract(" + v + ",'$." + path + "')", t = (name: string) => pg ? (name === 'sites' || name === 'revisions' ? 'public.' : 'private.') + name : name;
    return `rsites as (select id,${pg ? 'published_id' : j('data', 'publishedId')} published,${pg ? 'draft_id' : j('data', 'draftId')} draft,${j(pg ? 'input' : 'data', pg ? 'logoAssetId' : 'input.logoAssetId')} logo from ${t('sites')}),
rjobs as (select id,site_id,${j('data', 'state')} state,${pg ? 'checkpoint_id::text' : j('data', 'checkpointId')} cp,${j('data', 'edit.baseManifestId')} base,${j('data', 'providerRecovery.checkpointId')} recovery from ${t('jobs')}),
rrevisions as (${pg ? "select id::text id,site_id,manifest_id::text manifest from public.revisions" : "select id,site_id,json_extract(data,'$.manifestId') manifest from records where kind='revisions'"}),
rcandidates as (select id${pg ? '::text' : ''} id,${j('data', 'jobId')} job,${j('data', 'status')} status,${j('data', 'manifestId')} manifest,${j('data', 'baseManifestId')} base,${j('data', 'acceptance.state')} acceptance,${j('data', 'visualSave.state')} save from ${pg ? 'private.edit_requests' : "records where kind='candidates'"}),
rpublications as (select ${j('data', 'state')} state,${j('data', 'manifestId')} manifest from ${pg ? 'private.deployments' : "records where kind='publications'"}),
routcomes as (${pg ? "select id::text id,site_id,revision_id::text revision,manifest_id::text manifest,coalesce(settled_at,verified_at) settled_at,settled_seq seq,verified_at verified,settlement from private.provider_publications" : "select id,site_id,json_extract(data,'$.revisionId') revision,json_extract(data,'$.manifestId') manifest,json_extract(data,'$.settledAt') settled_at,json_extract(data,'$.sequence') seq,json_extract(data,'$.verifiedAt') verified,json_extract(data,'$.settlement') settlement from publication_outcomes"}),
settled as (select o.*,row_number() over(partition by site_id order by coalesce(seq,0) desc,settled_at desc,id desc) n from routcomes o where settlement='settled'),
current_outcome as (select s.site_id,min(s.n) n from settled s join rsites p on s.site_id=p.id and s.revision=p.published${pg ? '::text' : ''} group by s.site_id),
ordered as (select s.*,row_number() over(partition by s.site_id order by case when c.n=s.n then 0 else 1 end,s.n) keep_n from settled s left join current_outcome c on c.site_id=s.site_id),
kept as (select k.* from ordered k where keep_n<=6 or (seq is null and exists(select 1 from ordered b where b.site_id=k.site_id and b.keep_n=6 and b.seq is null and b.settled_at=k.settled_at))),
selected_revisions(id) as (${selected ? 'select id from retention_selected' : `select published${pg ? '::text' : ''} from rsites union select draft${pg ? '::text' : ''} from rsites union select revision from kept union select revision from routcomes where verified is not null and settlement not in ('settled','cancelled')`}),
root_input(kind,id,purpose) as (
 select 'artifact',r.manifest,'retained' from rrevisions r join selected_revisions s on s.id=r.id
 union all select 'artifact',manifest,'retained' from kept
 union all select 'artifact',manifest,'retained' from routcomes where verified is not null and settlement not in ('settled','cancelled')
 union all select 'checkpoint',j.cp,'retained' from selected_revisions s join rcandidates c on c.id=s.id join rjobs j on j.id${pg ? '::text' : ''}=c.job
 union all select 'checkpoint',j.cp,'retained' from selected_revisions s join rrevisions r on r.id=s.id join rjobs j on j.id=r.site_id where not exists(select 1 from rcandidates c where c.id=s.id)
 union all select 'resource',logo,'retained' from rsites
 union all select 'checkpoint',cp,'execution' from rjobs where state not in ('completed','cancelled')
 union all select 'artifact',base,'execution' from rjobs where state not in ('completed','cancelled')
 union all select 'checkpoint',recovery,'execution' from rjobs where state not in ('completed','cancelled')
 union all select 'artifact',manifest,'retained' from rcandidates where status in ('queued','running','checking','ready','conflict') or acceptance='pending' or save='pending'
 union all select 'artifact',base,'execution' from rcandidates where status='ready'
 union all select 'checkpoint',j.cp,case when j.state not in ('completed','cancelled') and c.status in ('queued','running','checking') then 'execution' else 'retained' end from rcandidates c join rjobs j on j.id${pg ? '::text' : ''}=c.job where c.status in ('queued','running','checking','ready','conflict') or c.acceptance='pending' or c.save='pending'
 union all select 'artifact',manifest,'execution' from rpublications where state='pending'
 ${pg ? "union all select 'artifact',binding->>'manifestId','execution' from private.publication_reservations where resolution is null union all select 'checkpoint',binding->>'checkpointId','execution' from private.publication_reservations where resolution is null union all select 'catalog',v,'execution' from private.recovery_state s cross join lateral jsonb_array_elements_text(s.data->'versions') v where s.key='installed-catalog'" : ""}
 union all select 'resource',r.id${pg ? '::text' : ''},'execution' from ${pg ? 'private.import_resources' : 'resources'} r join ${t('batches')} b on b.id=coalesce(${pg ? "(r.data->>'draftId')::uuid" : "json_extract(r.data,'$.draftId')"},r.id) where b.state in ('uploading','preview') or (b.state in ('active','paused') and exists(select 1 from ${t('batch_rows')} br left join rjobs j on j.id=br.site_id where br.batch_id=b.id and (br.site_id is null or j.state not in ('completed','cancelled'))))
), closure(kind,id,purpose) as (select kind,id,purpose from root_input where id is not null and id<>'' union select e.target_kind,e.target_id,c.purpose from closure c join ${t('payload_edges')} e on e.owner_kind=c.kind and e.owner_id=c.id where e.purpose=c.purpose or c.purpose='execution')`;
}
const temporary = (pg: boolean) => `create temp table ${pg ? '' : 'if not exists '}retention_evidence(id text primary key)${pg ? ' on commit drop' : ''};create temp table ${pg ? '' : 'if not exists '}retention_closure(kind text not null,id text not null,purpose text not null,primary key(kind,id,purpose))${pg ? ' on commit drop' : ''};create temp table ${pg ? '' : 'if not exists '}retention_protected(kind text not null,id text not null,primary key(kind,id))${pg ? ' on commit drop' : ''};create temp table ${pg ? '' : 'if not exists '}retention_unknown(site_id text primary key)${pg ? ' on commit drop' : ''};create temp table ${pg ? '' : 'if not exists '}retention_candidates(kind text not null,id text not null,primary key(kind,id))${pg ? ' on commit drop' : ''};`;
export async function materializePostgres(tx: SqlTransaction, now: number, checked = false) {
    await tx.query("set local statement_timeout='15s';set local work_mem='4MB'");
    if (!checked)
        await preflightPostgres(tx);
    await tx.query(temporary(true));
    await tx.query('insert into retention_evidence select id::text from private.checkpoint_evidence');
    await tx.query('analyze retention_evidence');
    await tx.query('with recursive ' + relations(true) + ' insert into retention_closure select * from closure');
    await tx.query('analyze retention_closure');
    await tx.query("insert into retention_protected select distinct kind,id from retention_closure c where kind<>'checkpoint' or purpose='execution' or not exists(select 1 from retention_evidence e where e.id=c.id) union select kind,payload_id from private.payload_pins where expires_at>to_timestamp($1/1000.0)", [now]);
    await tx.query("insert into retention_unknown select distinct site_id::text from private.payload_inventory p where p.kind='checkpoint' and (exists(select 1 from retention_closure c where c.kind='checkpoint' and c.id=p.id) or exists(select 1 from retention_protected r where r.kind='checkpoint' and r.id=p.id)) and not exists(select 1 from retention_evidence e where e.id=p.id) and site_id is not null union select site_id::text from private.jobs j where checkpoint_id is not null and not exists(select 1 from retention_evidence e where e.id=j.checkpoint_id::text)");
    await tx.query('analyze retention_protected;analyze retention_unknown');
}
export function materializeLocal(sql: DatabaseSync, now: number) { preflightLocal(sql); sql.exec(temporary(false) + 'delete from retention_evidence;insert into retention_evidence select id from checkpoint_evidence;delete from retention_closure;delete from retention_protected;delete from retention_unknown;delete from retention_candidates;'); sql.exec('create temp table if not exists retention_selected(id text primary key);delete from retention_selected;with recursive ' + relations(false) + ' insert into retention_selected select id from selected_revisions where id is not null;with recursive ' + relations(false, true) + ' insert into retention_closure select * from closure'); sql.prepare("insert or ignore into retention_protected select distinct kind,id from retention_closure c where kind<>'checkpoint' or purpose='execution' or not exists(select 1 from retention_evidence e where e.id=c.id) union select kind,payload_id from payload_pins where expires_at>?").run(now); sql.exec("insert or ignore into retention_unknown select distinct site_id from payload_inventory p where p.kind='checkpoint' and (exists(select 1 from retention_closure c where c.kind='checkpoint' and c.id=p.id) or exists(select 1 from retention_protected r where r.kind='checkpoint' and r.id=p.id)) and not exists(select 1 from retention_evidence e where e.id=p.id) and site_id is not null union select site_id from jobs j where json_extract(data,'$.checkpointId') is not null and not exists(select 1 from retention_evidence e where e.id=json_extract(j.data,'$.checkpointId'))"); }
export function eligibility(pg: boolean) { const p = pg ? 'private.' : '', json = (key: string) => pg ? "(p.data->>'" + key + "')" : "json_extract(p.data,'$." + key + "')", now = pg ? '$1' : '?1'; return `not exists(select 1 from retention_protected r where r.kind=p.kind and r.id=p.id) and coalesce(cast(${json('protectUntil')} as bigint),0)<=${now} and (p.site_id is null or not exists(select 1 from retention_unknown u where u.site_id=p.site_id${pg ? '::text' : ''})) ${pg ? '' : "and not (p.site_id is null and p.kind='screenshot' and exists(select 1 from retention_unknown))"} and not (p.kind='checkpoint' and ${pg ? "coalesce((p.data->>'accepted')::boolean,true)" : "coalesce(json_extract(p.data,'$.accepted'),1)<>0"} and (cast(${json('createdAt')} as bigint)+2592000000>${now} or (${pg ? 'true' : "coalesce(json_extract(p.data,'$.accepted'),0)=1"} and not exists(select 1 from retention_evidence e where e.id=p.id))))`; }
