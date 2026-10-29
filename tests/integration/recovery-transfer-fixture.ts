import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { projectCheckpoint } from '../../packages/core/src/usage.js';
import { DatabaseSync } from 'node:sqlite';
import type { RecoveryRestoreStream } from '../../apps/worker/src/remote-recovery-transfer.js';
import type { RecoveryRecord } from '../../packages/adapters/src/recovery-records.js';
import { identities } from './database.js';
export const recoveryVolumeSql = `
 create temp table volume as select site,action,md5('s'||site)::uuid site_id,md5('m'||site||'/'||action)::uuid manifest_id,md5('r'||site||'/'||action)::uuid revision_id,md5('r'||site||'/'||(action-1))::uuid parent_id,case when action=1 then md5('s'||site)::uuid else md5('j'||site||'/'||action)::uuid end job_id,md5('c'||site||'/'||action)::uuid checkpoint_id,md5('p'||site||'/'||action)::uuid publication_id from generate_series(1,5000) site cross join generate_series(1,6) action;
 create unique index volume_id on volume(site,action);
 insert into public.sites(id,domain,owner_id,input) select distinct site_id,'volume-'||site||'.example','${identities.admin}'::uuid,jsonb_build_object('domain','volume-'||site||'.example','about',repeat('Relevant site description. ',8)) from volume;
 insert into private.workers(id,name,token_hash) values('44444444-4444-4444-8444-444444444444','volume worker',repeat('e',64));
 insert into private.jobs(id,site_id,data) select job_id,site_id,jsonb_build_object('id',job_id,'siteId',site_id,'kind',case when action=1 then 'generate' else 'edit' end,'state','completed','stage','completed','checkpointId',checkpoint_id,'baseRevision',action-1,'generation',jsonb_build_object('seed',1,'styleId','editorial','templateVersion','1.0.0')) from volume;
 insert into private.artifacts select manifest_id,site_id,jsonb_build_object('id',manifest_id,'siteId',site_id,'templateVersion','1.0.0','createdAt',1,'files',(select jsonb_agg(jsonb_build_object('path',case f when 0 then 'index.html' when 1 then 'styles.css' when 2 then 'notes.js' when 3 then 'assets/one.svg' else 'assets/two.svg' end,'objectKey','private/artifacts/'||site_id||'/'||manifest_id||'/files/'||f,'size',10000,'sha256',repeat('a',64),'sha1',repeat('b',40),'mediaType',case f when 0 then 'text/html' when 1 then 'text/css' when 2 then 'text/javascript' else 'image/svg+xml' end)) from generate_series(0,4) f)),true from volume;
 insert into public.revisions select revision_id,site_id,case when action=1 then null else parent_id end,manifest_id,'published',action from volume order by site,action;
 update public.sites s set published_id=v.revision_id,revision=6,generation_status='completed' from volume v where v.action=6 and s.id=v.site_id;
 insert into private.checkpoints(id,site_id,job_id,worker_id,generation,metadata,manifest_id) select checkpoint_id,site_id,job_id,'44444444-4444-4444-8444-444444444444',1,jsonb_build_object('checkpoint',jsonb_build_object('id',checkpoint_id,'jobId',job_id,'stage','completed','manifestId',manifest_id,'stateKey','private/checkpoints/'||site_id||'/'||checkpoint_id||'/state','createdAt',1),'manifest',jsonb_build_object('id',checkpoint_id,'siteId',site_id,'templateVersion','1.0.0','createdAt',1,'files',jsonb_build_array(jsonb_build_object('path','index.html','objectKey','private/checkpoints/'||site_id||'/'||checkpoint_id||'/files/0','size',100000,'sha256',repeat('a',64),'sha1',repeat('b',40),'mediaType','text/html'))),'state',jsonb_build_object('path','@state','objectKey','private/checkpoints/'||site_id||'/'||checkpoint_id||'/state','size',100000,'sha256',repeat('a',64),'sha1',repeat('b',40),'mediaType','application/json')),manifest_id from volume;
 update private.jobs j set checkpoint_id=v.checkpoint_id from volume v where j.id=v.job_id;
 insert into private.edit_requests select revision_id,v.site_id,v.job_id,jsonb_build_object('id',revision_id,'jobId',v.job_id,'siteId',v.site_id,'status','accepted','manifestId',manifest_id,'baseManifestId',md5('m'||site||'/'||(action-1))::uuid,'baseRevision',action-1,'summary',repeat('A concise completed change. ',5),'job',j.data,'validation',jsonb_build_object('ok',true,'issues','[]'::jsonb,'screenshotIds',jsonb_build_array('validation/'||md5('png1'||v.checkpoint_id)::uuid||'.png','validation/'||md5('png2'||v.checkpoint_id)::uuid||'.png')),'acceptance',jsonb_build_object('expectedRevision',action-1,'state','completed')) from volume v join private.jobs j on j.id=v.job_id where action>1;
 insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id,resolution) select publication_id,site_id,publication_id::text,jsonb_build_object('revisionId',revision_id,'manifestId',manifest_id,'checkpointId',checkpoint_id,'expectedRevision',action-1),'44444444-4444-4444-8444-444444444444','settled' from volume;
 insert into private.provider_accounts(id) values('team_volume');
 insert into private.provider_publications(id,site_id,revision_id,manifest_id,manifest_hash,account_id,phase,settlement,verified_at,settled_seq,settled_at,data) select publication_id,site_id,revision_id,manifest_id,repeat('a',64),'team_volume','published','settled',100,site*6+action,100,jsonb_build_object('projectId','prj_volume','projectName','sf-'||site_id,'domain','volume-'||site||'.example','revision',jsonb_build_object('id',revision_id,'siteId',site_id,'manifestId',manifest_id),'policyVersion','static-v1','policyHash',repeat('a',64)) from volume;
 insert into private.checkpoint_evidence select checkpoint_id,v.job_id,jsonb_build_object('version',1,'checkpoint',c.metadata->'checkpoint','state',jsonb_build_object('siteId',v.site_id,'jobId',v.job_id,'manifestId',v.manifest_id,'revisionId',revision_id,'selection',jsonb_build_object('seed',1,'styleId','editorial','templateVersion','1.0.0'),'validation',jsonb_build_object('ok',true,'issues','[]'::jsonb,'screenshotIds',jsonb_build_array('validation/'||md5('png1'||v.checkpoint_id)::uuid||'.png','validation/'||md5('png2'||v.checkpoint_id)::uuid||'.png'))),'sourceDigest',repeat('a',64),'filesDigest',repeat('a',64),'digest',repeat('a',64)) from volume v join private.checkpoints c on c.id=v.checkpoint_id;
 insert into private.job_usage select job_id,checkpoint_id,jsonb_build_object('version',1,'jobId',job_id,'checkpointId',checkpoint_id,'predecessor',null,'inputTokens',1000,'outputTokens',500,'uncertainRequests',0,'requestPending',false,'provenance','provider','coverage','known-subtotal','durationMs',null,'imageTokens',null) from volume;
 insert into private.payload_inventory select 'artifact',a.id::text,a.site_id,jsonb_build_object('kind','artifact','id',a.id,'siteId',a.site_id,'createdAt',1,'protectUntil',0,'objects',(select jsonb_agg(jsonb_build_object('key',f->>'objectKey','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType')) from jsonb_array_elements(a.manifest->'files') f)),'available',null,null from private.artifacts a;
 insert into private.payload_inventory select 'checkpoint',c.id::text,c.site_id,jsonb_build_object('kind','checkpoint','id',c.id,'siteId',c.site_id,'createdAt',1,'protectUntil',0,'accepted',true,'objects',(select jsonb_agg(jsonb_build_object('key',f->>'objectKey','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType')) from jsonb_array_elements((c.metadata#>'{manifest,files}')||jsonb_build_array(c.metadata->'state')) f)),'available',null,null from private.checkpoints c;
 insert into private.payload_inventory select 'screenshot','validation/'||md5('png'||n||v.checkpoint_id)::uuid||'.png',site_id,jsonb_build_object('kind','screenshot','id','validation/'||md5('png'||n||v.checkpoint_id)::uuid||'.png','siteId',site_id,'createdAt',1,'protectUntil',0,'producer',jsonb_build_object('jobId',job_id,'workerId','44444444-4444-4444-8444-444444444444','generation',1),'objects',jsonb_build_array(jsonb_build_object('key','private/validation/'||site_id||'/'||md5('png'||n||v.checkpoint_id)::uuid||'/files/0','size',100000,'sha256',repeat('a',64),'mediaType','image/png'))),'available',null,null from volume v cross join generate_series(1,2) n;
 insert into private.payload_edges select 'checkpoint',checkpoint_id::text,purpose,'artifact',manifest_id::text from volume cross join (values('execution'),('retained')) p(purpose);
 insert into private.payload_edges select 'checkpoint',checkpoint_id::text,purpose,'screenshot','validation/'||md5('png'||n||checkpoint_id)::uuid||'.png' from volume cross join generate_series(1,2) n cross join (values('execution'),('retained')) p(purpose);
 insert into private.payload_edges select 'checkpoint',checkpoint_id::text,purpose,'catalog','editorial@1.0.0' from volume cross join (values('execution'),('retained')) p(purpose);
 `;
export async function seedRecoveryTransferVolume(pool: Pool, sites = 5000) {
    if (!Number.isInteger(sites) || sites < 1 || sites > 5000)
        throw new Error('fixture size');
    await pool.query(recoveryVolumeSql.replace('generate_series(1,5000)', 'generate_series(1,' + sites + ')'));
}
/** Same normalized generator/counts, actual valid smaller bodies. This is NOT 13.5GB. */
export async function seedSmallBodyRecoveryVolume(pool: Pool, sites = 5000) {
    if (!Number.isInteger(sites) || sites < 1 || sites > 5000)
        throw new Error('fixture size');
    const tx = await pool.connect();
    const hash = (bytes: Uint8Array, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
    const source = ['<!doctype html><html lang="en"><head><title>Saved</title></head><body><h1>Saved source</h1></body></html>', 'body{color:#111;background:#fff}', 'document.documentElement.dataset.ready="yes";', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>'];
    const bodies = [...source.map(s => Buffer.from(s)), ...([375, 1440].map(width => PNG.sync.write(new PNG({
            width, height: 900
        }))))];
    const files = bodies.map((bytes, f) => ({
        f, bytes: '\\x' + bytes.toString('hex'), size: bytes.length, sha256: hash(bytes), sha1: hash(bytes, 'sha1')
    }));
    try {
        await tx.query('create table private.fixture_files(f int primary key,bytes bytea,size int,sha256 text,sha1 text);create table private.fixture_checkpoints(id uuid primary key,state bytea,metadata jsonb,evidence jsonb)');
        await tx.query('insert into private.fixture_files select * from jsonb_to_recordset($1::jsonb) f(f int,bytes bytea,size int,sha256 text,sha1 text)', [JSON.stringify(files)]);
        let sql = recoveryVolumeSql.replace('generate_series(1,5000)', 'generate_series(1,' + sites + ')');
        sql = sql.replace("'size',10000,'sha256',repeat('a',64),'sha1',repeat('b',40)", "'size',bodies.size,'sha256',bodies.sha256,'sha1',bodies.sha1").replace('from generate_series(0,4) f)', 'from generate_series(0,4) f(value) join private.fixture_files bodies on bodies.f=f.value)');
        sql = sql.replaceAll('case f when', 'case f.value when').replaceAll("||f,'size'", "||f.value,'size'");
        const checkpointStart = sql.indexOf(' insert into private.checkpoints('), checkpointEnd = sql.indexOf(' update private.jobs', checkpointStart);
        await tx.query(sql.slice(0, checkpointStart));
        let afterSite = 0, afterAction = 0;
        for (;;) {
            const rows = (await tx.query("select *,md5('png1'||checkpoint_id)::uuid png1,md5('png2'||checkpoint_id)::uuid png2 from volume where (site,action)>($1,$2) order by site,action limit 128", [afterSite, afterAction])).rows;
            if (!rows.length)
                break;
            const batch = rows.map(v => {
                const checkpoint = {
                    id: v.checkpoint_id, jobId: v.job_id, stage: 'completed', manifestId: v.manifest_id, stateKey: `private/checkpoints/${v.site_id}/${v.checkpoint_id}/state`, createdAt: 1
                };
                const state = {
                    siteId: v.site_id, jobId: v.job_id, manifestId: v.manifest_id, revisionId: v.revision_id, selection: {
                        seed: 1, styleId: 'editorial', templateVersion: '1.0.0'
                    }, validation: {
                        ok: true, issues: [], screenshotIds: [`validation/${v.png1}.png`, `validation/${v.png2}.png`]
                    }
                };
                const stateBytes = Buffer.from(JSON.stringify(state)), file = {
                    path: 'index.html', objectKey: `private/checkpoints/${v.site_id}/${v.checkpoint_id}/files/0`, size: bodies[0]!.length, sha256: hash(bodies[0]!), sha1: hash(bodies[0]!, 'sha1'), mediaType: 'text/html'
                };
                const metadata = {
                    checkpoint, manifest: {
                        id: v.checkpoint_id, siteId: v.site_id, templateVersion: '1.0.0', createdAt: 1, files: [file]
                    }, state: {
                        path: '@state', objectKey: checkpoint.stateKey, size: stateBytes.length, sha256: hash(stateBytes), sha1: hash(stateBytes, 'sha1'), mediaType: 'application/json'
                    }
                };
                return {
                    id: v.checkpoint_id, state: '\\x' + stateBytes.toString('hex'), metadata, evidence: projectCheckpoint(checkpoint, state, [{
                            path: 'index.html', mediaType: 'text/html', bytes: bodies[0]!
                        }], null).evidence
                };
            });
            await tx.query('insert into private.fixture_checkpoints select * from jsonb_to_recordset($1::jsonb) f(id uuid,state bytea,metadata jsonb,evidence jsonb)', [JSON.stringify(batch)]);
            afterSite = rows.at(-1)!.site;
            afterAction = rows.at(-1)!.action;
        }
        const replacement = " insert into private.checkpoints(id,site_id,job_id,worker_id,generation,metadata,manifest_id) select v.checkpoint_id,v.site_id,v.job_id,'44444444-4444-4444-8444-444444444444',1,f.metadata,v.manifest_id from volume v join private.fixture_checkpoints f on f.id=v.checkpoint_id;\n";
        sql = replacement + sql.slice(checkpointEnd);
        const evidenceStart = sql.indexOf(' insert into private.checkpoint_evidence '), evidenceEnd = sql.indexOf(' insert into private.job_usage ', evidenceStart);
        sql = sql.slice(0, evidenceStart) + " insert into private.checkpoint_evidence select c.id,c.job_id,f.evidence from private.checkpoints c join private.fixture_checkpoints f on f.id=c.id;\n" + sql.slice(evidenceEnd);
        sql = sql.replace("'size',100000,'sha256',repeat('a',64),'mediaType','image/png'", "'size',(select size from private.fixture_files where f=n+4),'sha256',(select sha256 from private.fixture_files where f=n+4),'mediaType','image/png'");
        await tx.query(sql);
        await tx.query(`create table private.fixture_objects(key text primary key,bytes bytea not null,media text not null);
   insert into private.fixture_objects select f.file->>'objectKey',b.bytes,f.file->>'mediaType' from private.artifacts a cross join lateral jsonb_array_elements(a.manifest->'files') f(file) join private.fixture_files b on b.f=split_part(f.file->>'objectKey','/',6)::int;
   insert into private.fixture_objects select c.metadata#>>'{manifest,files,0,objectKey}',b.bytes,'text/html' from private.checkpoints c cross join private.fixture_files b where b.f=0;
   insert into private.fixture_objects select metadata#>>'{checkpoint,stateKey}',state,'application/json' from private.fixture_checkpoints;
   insert into private.fixture_objects select 'private/validation/'||v.site_id||'/'||md5('png'||n||v.checkpoint_id)::uuid||'/files/0',b.bytes,'image/png' from volume v cross join generate_series(1,2) n join private.fixture_files b on b.f=n+4;`);
        return {
            sites, states: sites * 6, bodyBytes: Number((await tx.query('select sum(octet_length(bytes)) n from private.fixture_objects')).rows[0].n), bodyCount: Number((await tx.query('select count(*) n from private.fixture_objects')).rows[0].n)
        };
    }
    finally {
        tx.release();
    }
}
/** Real disk-paged transport input, deliberately starts AFTER encrypted extraction. */
export class RecoveryTransferSpool {
    readonly db: DatabaseSync;
    private pending = false;
    private writes = 0;
    private writtenBytes = 0;
    private recordInsert: any;
    private payloadInsert: any;
    private destinationInsert: any;
    constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('pragma journal_mode=off;pragma synchronous=off;pragma cache_size=-4096;pragma temp_store=file;create table records(seq integer primary key,bytes blob not null,kind text not null);create table payloads(seq integer primary key,bytes blob not null);create table destination(key text primary key,bytes blob not null,media text not null);create index records_kind on records(kind,seq)'); this.recordInsert = this.db.prepare('insert into records values(?,?,?)'); this.payloadInsert = this.db.prepare('insert into payloads values(?,?)'); this.destinationInsert = this.db.prepare('insert into destination values(?,?,?)'); }
    private write(bytes: number, action: () => void) { if (bytes > 1024 ** 2)
        throw new Error('small-body spool bound'); if (this.pending && (this.writes === 256 || this.writtenBytes + bytes > 1024 ** 2))
        this.flush(); if (!this.pending) {
        this.db.exec('begin');
        this.pending = true;
    } action(); this.writes++; this.writtenBytes += bytes; }
    flush() { if (this.pending) {
        this.db.exec('commit');
        this.pending = false;
        this.writes = 0;
        this.writtenBytes = 0;
    } }
    putRecord(seq: number, bytes: Uint8Array, record: RecoveryRecord) { this.write(bytes.length, () => this.recordInsert.run(seq, bytes, record.type)); }
    putPayload(seq: number, bytes: Uint8Array) { this.write(bytes.length, () => this.payloadInsert.run(seq, bytes)); }
    get records() { return Number(this.db.prepare('select count(*) n from records').get()!.n); }
    stream(): RecoveryRestoreStream {
        this.flush();
        const db = this.db, root = createHash('sha256');
        let group = createHash('sha256'), n = 0;
        for (let after = -1;;) {
            const rows = db.prepare('select seq,bytes from records where seq>? order by seq limit 256').all(after);
            if (!rows.length)
                break;
            for (const row of rows) {
                after = Number(row.seq);
                const b = row.bytes as Uint8Array;
                group.update(JSON.stringify([after, b.length, createHash('sha256').update(b).digest('hex')]) + '\n');
                if (++n % 256 === 0) {
                    root.update(group.digest('hex'));
                    group = createHash('sha256');
                }
            }
        }
        if (n % 256)
            root.update(group.digest('hex'));
        return {
            header: JSON.parse(Buffer.from(db.prepare('select bytes from records where seq=0').get()!.bytes as Uint8Array).toString('utf8')), records: n, inventoryDigest: root.digest('hex'),
            metadata: async function* () { for (let after = -1;;) {
                const rows = db.prepare('select seq,bytes from records where seq>? order by seq limit 256').all(after);
                if (!rows.length)
                    break;
                for (const r of rows) {
                    after = Number(r.seq);
                    yield {
                        seq: after, bytes: r.bytes as Uint8Array
                    };
                }
            } },
            resources: async function* () { for (let after = -1;;) {
                const rows = db.prepare("select seq,bytes from records where seq>? and kind='file' order by seq limit 64").all(after);
                if (!rows.length)
                    break;
                for (const r of rows) {
                    after = Number(r.seq);
                    const seq = after;
                    yield {
                        seq, record: JSON.parse(Buffer.from(r.bytes as Uint8Array).toString('utf8')), read: async (offset: number, length: number) => { const p = db.prepare('select substr(bytes,?,?) bytes from payloads where seq=?').get(offset + 1, length, seq); if (!p)
                            throw new Error('missing fixture body'); return p.bytes as Uint8Array; }
                    };
                }
            } }
        };
    }
    transport() { const db = this.db; return {
        signPut: async () => '', put: async (key: string, bytes: Uint8Array, media: string) => { this.write(bytes.length, () => this.destinationInsert.run(key, bytes, media)); }, get: async (key: string) => { const r = db.prepare('select bytes from destination where key=?').get(key); if (!r)
            throw new Error('missing independent body'); return r.bytes as Uint8Array; }, head: async (key: string) => { const r = db.prepare('select length(bytes) size,media mediaType from destination where key=?').get(key); if (!r)
            throw new Error('missing independent body'); return {
            size: Number(r.size), mediaType: String(r.mediaType)
        }; }, delete: async (key: string) => { db.prepare('delete from destination where key=?').run(key); }
    }; }
    close() { this.flush(); this.db.close(); }
}
