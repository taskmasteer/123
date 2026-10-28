import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openLocalDatabase } from '../src/local-database.js';
import { LocalRetention } from '../src/local-retention.js';
import { createLocalArtifacts } from '../src/local-artifacts.js';
import { LocalBackup } from '../src/local-backup.js';
import { preflightLocal } from '../src/retention-sql.js';
it('captures and collects actual local5000×6 normalized metadata with five source files and two PNGs per state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-retention-volume-')), db = await openLocalDatabase(root), start = performance.now(), before = process.memoryUsage();
    try {
        db.transaction(() => db.sql.exec(`
 create temp table volume as with recursive n(x) as (values(1) union all select x+1 from n where x<5000),a(x) as (values(1) union all select x+1 from a where x<6) select n.x site,a.x action,printf('%08x-0000-4000-8000-%012x',n.x,0) site_id,printf('%08x-1000-4000-8000-%012x',n.x,a.x) manifest,printf('%08x-2000-4000-8000-%012x',n.x,a.x) revision,case when a.x=1 then printf('%08x-0000-4000-8000-%012x',n.x,0) else printf('%08x-3000-4000-8000-%012x',n.x,a.x) end job,printf('%08x-4000-4000-8000-%012x',n.x,a.x) checkpoint from n cross join a;
 create index volume_site on volume(site,action);
 insert into sites(id,domain,owner_id,status,data) select site_id,'volume-'||site||'.test','admin','completed',json_object('id',site_id,'domain','volume-'||site||'.test','ownerId','admin','input',json_object('domain','volume-'||site||'.test'),'revision',6,'publishedId',revision,'draftId',null,'generationStatus','completed','domainStatus','demo') from volume where action=6;
 insert into jobs(id,site_id,state,data) select job,site_id,'completed',json_object('id',job,'siteId',site_id,'kind',case when action=1 then 'generate' else 'edit' end,'state','completed','stage','completed','checkpointId',checkpoint,'baseRevision',action-1) from volume;
 insert into records select 'revisions',revision,site_id,json_object('id',revision,'siteId',site_id,'manifestId',manifest,'parentId',case when action=1 then null else printf('%08x-2000-4000-8000-%012x',site,action-1) end,'createdAt',action,'kind','published') from volume;
 insert into records select 'candidates',revision,site_id,json_object('id',revision,'jobId',job,'siteId',site_id,'status','accepted','manifestId',manifest,'baseManifestId',printf('%08x-1000-4000-8000-%012x',site,action-1)) from volume where action>1;
 insert into publication_outcomes select 'outcome-'||revision,site_id,json_object('id','outcome-'||revision,'siteId',site_id,'revisionId',revision,'manifestId',manifest,'sequence',site*6+action,'settledAt',100,'verifiedAt',100,'settlement','settled','origin','draft','mode','demo') from volume;
 insert into checkpoint_evidence select checkpoint,job,json_object('version',1,'checkpoint',json_object('id',checkpoint,'jobId',job,'createdAt',1),'state',json_object('siteId',site_id,'jobId',job,'manifestId',manifest),'digest','metadata-capacity-fixture') from volume;
 insert into job_usage select job,checkpoint,json_object('version',1,'jobId',job,'checkpointId',checkpoint,'inputTokens',1000,'outputTokens',500) from volume;
 insert into payload_inventory select 'artifact',manifest,site_id,json_object('kind','artifact','id',manifest,'siteId',site_id,'createdAt',1,'protectUntil',0,'objects',(select json_group_array(json_object('key','manifests/'||manifest||'/'||f||'.bin','size',10000,'sha256',printf('%064d',0),'mediaType','text/plain')) from (select 0 f union all select 1 union all select 2 union all select 3 union all select 4))),'available',null,null from volume;
 insert into payload_inventory select 'checkpoint',checkpoint,site_id,json_object('kind','checkpoint','id',checkpoint,'siteId',site_id,'createdAt',1,'protectUntil',0,'accepted',json('true'),'objects',json_array(json_object('key',checkpoint||'.json','size',200000,'sha256',printf('%064d',0),'mediaType','application/json'))),'available',null,null from volume;
 insert into payload_inventory select 'screenshot','validation/'||printf('%08x-5000-4000-8000-%012x',site,action*2+n)||'.png',site_id,json_object('kind','screenshot','id','validation/'||printf('%08x-5000-4000-8000-%012x',site,action*2+n)||'.png','siteId',site_id,'createdAt',1,'protectUntil',0,'objects',json_array(json_object('key',printf('%08x-5000-4000-8000-%012x',site,action*2+n)||'.png','size',100000,'sha256',printf('%064d',0),'mediaType','image/png'))),'available',null,null from volume cross join (select 1 n union all select 2);
 insert into payload_edges select 'checkpoint',checkpoint,purpose,'artifact',manifest from volume cross join (select 'execution' purpose union all select 'retained');
 insert into payload_edges select 'checkpoint',checkpoint,purpose,'screenshot','validation/'||printf('%08x-5000-4000-8000-%012x',site,action*2+n)||'.png' from volume cross join (select 1 n union all select 2) cross join (select 'execution' purpose union all select 'retained');
 insert into payload_edges select 'checkpoint',checkpoint,purpose,'catalog','editorial@1.0.0' from volume cross join (select 'execution' purpose union all select 'retained');
 insert into payload_pins select 'capacity-read','checkpoint',checkpoint,9999999999999 from volume;
 `));
        const collector = new LocalRetention(db), checked = preflightLocal(db.sql), phases: Record<string, number> = { seed: performance.now() - start };
        let protectedCount = 0;
        for (const key of collector.protected(Date.now())) {
            expect(typeof key).toBe('string');
            protectedCount++;
        }
        expect(protectedCount).toBe(120001);
        phases.protected = performance.now() - start;
        const snapshot = await db.snapshot(join(root, 'captured')), copy = new DatabaseSync(snapshot.database, { readOnly: true });
        try {
            expect(copy.prepare('select count(*) n from sites').get()!.n).toBe(5000);
            expect(copy.prepare('select count(*) n from publication_outcomes').get()!.n).toBe(30000);
            expect(copy.prepare('select count(*) n from payload_edges').get()!.n).toBe(240000);
        }
        finally {
            copy.close();
        }
        phases.snapshot = performance.now() - start;
        const artifacts = await createLocalArtifacts(join(root, 'artifacts'), { now: () => 1 }), orphan = await artifacts.put('other-site', [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('orphan') }], '1'), now = Date.now() + 32 * 86400000;
        expect((await collector.planCleanup(now)).deletableManifestIds).toEqual([]);
        expect((await collector.planCleanup(now + 86400001)).deletableManifestIds).toEqual([orphan.id]);
        await collector.collect(now + 86400002);
        expect(db.sql.prepare("select count(*) n from payload_inventory where state='available'").get()!.n).toBe(120000);
        await expect(artifacts.read(orphan.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        await writeFile('.local-state/task12-fix1-local-volume.json', JSON.stringify({ sites: 5000, states: 30000, logicalRows: checked.count, preflightBytes: checked.bytes, protectedCount, phases, elapsedMs: performance.now() - start, heapGrowth: process.memoryUsage().heapUsed - before.heapUsed, rssGrowth: process.memoryUsage().rss - before.rss }, null, 2));
        db.sql.prepare("insert into recovery_state values('oversized',?)").run(JSON.stringify({ content: 'x'.repeat(1000001) }));
        expect(() => collector.protected(Date.now())[Symbol.iterator]().next()).toThrow();
        await expect(new LocalBackup(db, process.cwd(), join(root, 'exports')).createBackup({ userId: 'admin', role: 'admin' }, 'over bound password')).rejects.toMatchObject({ code: 'NEEDS_ATTENTION' });
        await expect(access(join(root, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(db.sql.prepare('select count(*) n from recovery_snapshots').get()!.n).toBe(0);
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
}, 120000);
