import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { PostgresRetention } from '../../packages/adapters/src/postgres-retention.js';
import { R2Store } from '../../packages/adapters/src/r2-store.js';
import { it, expect } from 'vitest';
import { database, seedUsers, identities } from './database.js';
import { writeFile } from 'node:fs/promises';
import { managedRecoveryTables } from '../../packages/adapters/src/recovery-records.js';
it('measures actual5000×6 normalized history/private evidence and270000 physical descriptors before bounded snapshot capture', async () => {
    const pool = await database();
    await seedUsers(pool);
    try {
        await pool.query(`
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
 `);
        let logical = 0, bytes = 0;
        const tableCounts: Record<string, number> = {};
        for (const table of managedRecoveryTables) {
            const r = (await pool.query("select count(*) n,coalesce(sum(octet_length(jsonb_build_object('type','row','table',$1::text,'row',to_jsonb(t))::text)),0) bytes from " + table + ' t', [table])).rows[0];
            tableCounts[table] = Number(r.n);
            logical += Number(r.n);
            bytes += Number(r.bytes);
        }
        const physical = (await pool.query("select count(*) n,coalesce(sum(octet_length(jsonb_build_object('type','file','root','object','path',f->>'key','payload','payloads/999999.bin','size',f->'size','sha256',f->'sha256','mediaType',f->'mediaType')::text)),0) bytes,coalesce(sum((f->>'size')::bigint),0) bodies from private.payload_inventory cross join lateral jsonb_array_elements(data->'objects') f")).rows[0];
        const measurement = { sites: 5000, states: 30000, logicalRows: logical, fileRecords: Number(physical.n), metadataRecords: logical + Number(physical.n) + 1, zipEntriesBeforeIndex: logical + 2 * Number(physical.n) + 1, logicalBytes: bytes, fileRecordBytes: Number(physical.bytes), totalMetadataBytes: bytes + Number(physical.bytes), projectedBodyBytes: Number(physical.bodies), tableCounts };
        await writeFile('.local-state/task12-fix1-full-volume.json', JSON.stringify(measurement, null, 2));
        expect(measurement.fileRecords).toBe(270000);
        expect(measurement.states).toBe(30000);
        const before = process.memoryUsage(), repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo);
        const exclusiveFenceMs: number[] = [], transaction = repo.transaction.bind(repo), capture = repo.captureSnapshot.bind(repo);
        let captureHelperElapsedMs = 0;
        repo.transaction = (async (action: any, fence: any = 'shared') => transaction(async (tx) => { const t = performance.now(); try {
            return await action(tx);
        }
        finally {
            if (fence === 'exclusive')
                exclusiveFenceMs.push(performance.now() - t);
        } }, fence)) as typeof repo.transaction;
        repo.captureSnapshot = (async (action: any, fresh: any) => { const t = performance.now(); try {
            return await capture(action, fresh);
        }
        finally {
            captureHelperElapsedMs = performance.now() - t;
        } }) as typeof repo.captureSnapshot;
        let io = 0;
        const transport = { get: async () => { io++; throw new Error('Metadata-only representative never reads projected bodies'); }, signPut: async () => '', put: async () => { }, head: async () => { io++; throw new Error('No body heads'); }, delete: async () => { } };
        const store = new R2Store(repo, transport, queue), backup = new PostgresBackup(repo, store), start = performance.now(), snapshot = await backup.beginSnapshot({ userId: identities.admin, role: 'admin' });
        const captureMs = performance.now() - start;
        let indexBytes = 0, indexChunks = 0, chunkBytes = 0, zipMembers = 0, after = -1;
        for (;;) {
            const page = (await pool.query("select seq,octet_length(data::text) serialized,data->>'type' type,data->>'root' root,data->>'path' path,data->>'mediaType' media,data->>'payload' payload,data->>'size' size from private.recovery_snapshot_records where snapshot_id=$1 and seq>$2 order by seq limit 256", [snapshot.id, after])).rows;
            if (!page.length)
                break;
            for (const r of page) {
                after = Number(r.seq);
                const value = r.type === 'file' ? { name: r.payload, size: Number(r.size), sha256: 'a'.repeat(64), fileDescriptorV1: { recordName: 'records/' + r.seq + '.json', root: r.root, path: r.path, mediaType: r.media } } : { name: 'records/' + r.seq + '.json', size: Number(r.serialized), sha256: 'a'.repeat(64) };
                const length = Buffer.byteLength(JSON.stringify(value) + '\n');
                if (chunkBytes + length > 1024 ** 2) {
                    indexChunks++;
                    chunkBytes = 0;
                }
                chunkBytes += length;
                indexBytes += length;
                zipMembers++;
            }
        }
        if (chunkBytes)
            indexChunks++;
        expect(indexBytes).toBeLessThanOrEqual(192 * 1024 ** 2);
        expect(zipMembers + indexChunks).toBeLessThanOrEqual(1000000);
        expect(snapshot.records).toBe(measurement.metadataRecords);
        expect(io).toBe(0);
        let rootCount = 0;
        await repo.transaction(async (tx) => { const retention = new PostgresRetention(repo, transport); await retention.closure(tx, Date.now()); rootCount = Number((await tx.query('select count(*) n from retention_protected')).rows[0].n); expect((await tx.query("select count(*) n from retention_protected where kind='artifact'")).rows[0].n).toBe('30000'); expect((await tx.query("select count(*) n from retention_protected where kind='screenshot'")).rows[0].n).toBe('60000'); }, 'exclusive');
        const end = process.memoryUsage();
        await writeFile('.local-state/task12-fix1-full-volume.json', JSON.stringify({ ...measurement, snapshotRecords: snapshot.records, captureMs, compactIndexBytes: indexBytes, indexChunks, countedPlannedZipMembers: zipMembers + indexChunks, captureHelperElapsedMs, rootCount, heapGrowth: end.heapUsed - before.heapUsed, rssGrowth: end.rss - before.rss }, null, 2));
        await backup.close({ userId: identities.admin, role: 'admin' }, snapshot.id);
        const collector = new PostgresRetention(repo, transport), planStart = performance.now();
        expect((await collector.planCleanup(Date.now() + 32 * 86400000)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(Date.now() + 33 * 86400000 + 1)).deletableManifestIds).toEqual([]);
        await collector.collect(Date.now() + 33 * 86400000 + 2);
        expect((await pool.query("select count(*) n from private.payload_inventory where kind='checkpoint' and state='deleted'")).rows[0].n).toBe('30000');
        expect((await pool.query("select count(*) n from private.payload_inventory where kind in ('artifact','screenshot') and state='available'")).rows[0].n).toBe('90000');
        await writeFile('.local-state/task12-fix1-closure-measured.json', JSON.stringify({ rootCount, planAndCollectMs: performance.now() - planStart, maxExclusiveFenceMs: Math.max(...exclusiveFenceMs), exclusiveFenceMs, heapGrowth: process.memoryUsage().heapUsed - before.heapUsed }));
        const excess = 1000001 - measurement.logicalRows;
        await pool.query("insert into private.audit(actor_id,action,target_id) select $1,'capacity event',$2 from generate_series(1,$3::int)", [identities.admin, '00000000-0000-4000-8000-000000000001', excess]);
        await expect(backup.beginSnapshot({ userId: identities.admin, role: 'admin' })).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
        expect((await pool.query('select count(*) n from private.recovery_snapshots')).rows[0].n).toBe('0');
        expect((await pool.query('select count(*) n from private.payload_pins')).rows[0].n).toBe('0');
    }
    finally {
        await pool.end();
    }
}, 240000);
