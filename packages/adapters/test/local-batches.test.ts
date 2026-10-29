import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDatabase } from '../src/local-database.js';
import { LocalBatches } from '../src/local-batches.js';
import { createLocalQueue } from '../src/local-queue.js';
import { createLocalState } from '../src/local-state.js';
const owner = { userId: 'owner', role: 'user' } as const;
it('binds request keys to canonical rows, retains errors and isolates existing domain failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-batch-')), db = await openLocalDatabase(root), b = new LocalBatches(db);
    try {
        const rows = [{ rowNumber: 2, domain: 'пример.рф', about: 'Exact one-row about' }, { rowNumber: 3, domain: 'xn--e1afmkfd.xn--p1ai' }, { rowNumber: 4, domain: '' }, { rowNumber: 5, domain: 'next.test' }];
        const first = await b.submitBatch(owner, rows, 'request-1');
        expect(first.siteIds).toHaveLength(2);
        expect(await b.submitBatch(owner, rows, 'request-1')).toEqual(first);
        await expect(b.submitBatch(owner, [{ rowNumber: 2, domain: 'changed.test' }], 'request-1')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(2);
        expect((await b.page(owner, first.batchId)).items).toHaveLength(4);
        const conflict = await b.submitBatch(owner, [{ rowNumber: 2, domain: 'next.test' }, { rowNumber: 3, domain: 'other.test' }], 'request-2');
        expect(conflict.siteIds).toHaveLength(1);
        expect((await b.page(owner, conflict.batchId)).items[0]!.issues[0]!.code).toBe('DUPLICATE_DOMAIN');
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('keeps direct grants separate from batch scope through worker CAS and fences cancelled writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-local-grants-')), db = await openLocalDatabase(root), b = new LocalBatches(db), q = await createLocalQueue(root, { now: () => 1000 }, db), sites = await createLocalState(root, { now: () => 1000 }, db), admin = { userId: 'admin', role: 'admin' } as const;
    try {
        const batch = await b.submitBatch(owner, [{ rowNumber: 2, domain: 'grants.test' }], 'grants'), siteId = batch.siteIds[0]!;
        await sites.compareAndSet(siteId, 0, { assignedUserIds: ['direct'] });
        await expect(b.get({ userId: 'direct', role: 'spec-user' }, batch.batchId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await b.assign(admin, batch.batchId, ['assigned']);
        expect((await sites.get(siteId))!.assignedUserIds.sort()).toEqual(['assigned', 'direct']);
        const claim = (await q.claim('worker'))!;
        await sites.workerCompareAndSet(siteId, 1, { generationStatus: 'running' }, claim.lease);
        await b.assign(admin, batch.batchId, []);
        expect((await sites.get(siteId))!.assignedUserIds).toEqual(['direct']);
        await b.cancelBatch(owner, batch.batchId);
        await expect(sites.workerCompareAndSet(siteId, 2, { publishedId: 'must-not-install' }, claim.lease)).rejects.toMatchObject({ code: 'STALE_LEASE' });
        expect((await sites.get(siteId))!.publishedId).toBeNull();
    }
    finally {
        await q.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('pauses at stage boundaries, resumes only paused work and fences cancelled generation without touching later edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-pause-')), db = await openLocalDatabase(root), b = new LocalBatches(db), q = await createLocalQueue(root, { now: () => 1000 }, db);
    try {
        const batch = await b.submitBatch(owner, [{ rowNumber: 2, domain: 'a.test' }, { rowNumber: 3, domain: 'b.test' }], 'key');
        const claim = (await q.claim('worker'))!;
        await b.pauseBatch(owner, batch.batchId);
        expect(await q.claim('second')).toBeNull();
        expect(await q.pauseAtBoundary!(claim.lease)).toBe(true);
        await b.resumeBatch(owner, batch.batchId);
        const resumed = (await q.claim('worker'))!;
        await q.finish(resumed.lease, 'needs_attention');
        await b.pauseBatch(owner, batch.batchId);
        await b.resumeBatch(owner, batch.batchId);
        expect((await q.get(resumed.job.id))!.state).toBe('needs_attention');
        await expect(b.cancelBatch({ userId: 'assigned', role: 'spec-user' }, batch.batchId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await b.cancelBatch(owner, batch.batchId);
        expect(await q.claim('worker')).toBeNull();
    }
    finally {
        await q.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('projects current registry status across failures, running and pause/resume with filtered cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-status-')), db = await openLocalDatabase(root), b = new LocalBatches(db), q = await createLocalQueue(root, { now: () => 1000 }, db), sites = await createLocalState(root, { now: () => 1000 }, db);
    const workerA = 'worker-a', workerB = 'worker-b', current = (id: string) => q.current(id);
    let batchId: string;
    const pause = () => b.pauseBatch(owner, batchId), resume = () => b.resumeBatch(owner, batchId);
    try {
        const batch = await b.submitBatch(owner, Array.from({ length: 6 }, (_, i) => ({ rowNumber: i + 2, domain: 'status-' + i + '.test' })), 'status');
        batchId = batch.batchId;
        const a = (await q.claim(workerA))!, c = (await q.claim(workerA))!, d = (await q.claim(workerB))!;
        expect(a).not.toBeNull();
        expect(c).not.toBeNull();
        expect(d).not.toBeNull();
        await q.finish(a.lease, 'needs_attention');
        await q.finish(c.lease, 'needs_attention');
        const walk = async (status: string, expected: string[]) => {
            const ids: string[] = [];
            let cursor: string | undefined;
            do {
                const page = await sites.list(owner, cursor, 1, { status, batchId: batch.batchId });
                for (const site of page.items) {
                    expect((await current(site.id))?.state ?? site.generationStatus).toBe(status);
                    ids.push(site.id);
                }
                if (!cursor && page.nextCursor)
                    await expect(sites.list(owner, page.nextCursor, 1, { status: 'waiting_provider', batchId: batch.batchId })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            expect(ids.sort()).toEqual([...expected].sort());
            expect(new Set(ids).size).toBe(ids.length);
        };
        expect((await sites.get(a.job.siteId))!.generationStatus).toBe('queued');
        await walk('needs_attention', [a.job.siteId, c.job.siteId]);
        await walk('running', [d.job.siteId]);
        const unclaimed = batch.siteIds.filter(id => ![a.job.siteId, c.job.siteId, d.job.siteId].includes(id));
        await walk('queued', unclaimed);
        await pause();
        expect(await q.pauseAtBoundary!(d.lease)).toBe(true);
        await walk('paused', [d.job.siteId]);
        await walk('running', []);
        await resume();
        await walk('paused', []);
        await walk('queued', [...unclaimed, d.job.siteId]);
        await walk('needs_attention', [a.job.siteId, c.job.siteId]);
    }
    finally {
        await q.close();
        await sites.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

it('freezes adjacent batch directions before competing workers claim and preserves them on retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-directions-')),db=await openLocalDatabase(root),styles=['a','b','c'].map(id=>({id,name:id,version:'1.0.0',enabled:true,referenceIds:[]}));
 const b=new LocalBatches(db,{list:async()=>({styles,references:[]})}),q=await createLocalQueue(root,{now:()=>1000},db);
 try{const result=await b.submitBatch(owner,Array.from({length:6},(_,i)=>({rowNumber:i+2,domain:'direction-'+i+'.test'})),'directions');
 const jobs=result.siteIds.map(id=>JSON.parse(String(db.sql.prepare('select data from jobs where id=?').get(id)!.data)));
 expect(jobs.every(j=>j.generation)).toBe(true);for(let i=1;i<jobs.length;i++)expect(jobs[i].generation.styleId).not.toBe(jobs[i-1].generation.styleId);
 const a=(await q.claim('worker-a'))!,c=(await q.claim('worker-b'))!;expect(a.job.generation).not.toEqual(c.job.generation);const pinned=a.job.generation;
 await q.finish(a.lease,'needs_attention');styles[0]!.enabled=false;await q.retry(a.job.id);expect((await q.claim('worker-a'))!.job.generation).toEqual(pinned);
 }finally{await q.close();await db.close();await rm(root,{recursive:true,force:true});}
});
it('individual running cancellation revokes stale execution while retaining published content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-cancel-')),db=await openLocalDatabase(root),b=new LocalBatches(db),q=await createLocalQueue(root,{now:()=>1000},db),sites=await createLocalState(root,{now:()=>1000},db);
 try{const result=await b.submitBatch(owner,[{rowNumber:2,domain:'cancel.test'}],'cancel'),id=result.siteIds[0]!,claim=(await q.claim('worker'))!;
 await q.cancel(claim.job.id);expect((await q.get(id))!.state).toBe('cancelled');await expect(q.heartbeat(claim.lease)).rejects.toMatchObject({code:'STALE_LEASE'});await expect(sites.workerCompareAndSet(id,0,{publishedId:'stale'},claim.lease)).rejects.toMatchObject({code:'STALE_LEASE'});expect((await sites.get(id))!.publishedId).toBeNull();
 }finally{await q.close();await sites.close();await db.close();await rm(root,{recursive:true,force:true});}
});

it('checked first draft commits with its checkpoint, survives safe cancellation and fences different same-revision pointers',async()=>{
 const {runJob}=await import('../../../apps/worker/src/pipeline.js'),{createCheckpointStore}=await import('../../../apps/worker/src/checkpoints.js'),{createLocalArtifacts}=await import('../src/local-artifacts.js'),{createLocalRevisions}=await import('../src/local-revisions.js'),{FakeModel}=await import('../src/fake-model.js');
 const root=await mkdtemp(join(tmpdir(),'sf-first-draft-')),clock={now:()=>1000},db=await openLocalDatabase(root),sites=await createLocalState(root,clock,db),q=await createLocalQueue(root,clock,db),b=new LocalBatches(db),revisions=await createLocalRevisions(root,db),artifacts=await createLocalArtifacts(join(root,'artifacts'),clock),checkpoints=await createCheckpointStore(join(root,'checkpoints'),clock);
 try {const batch=await b.submitBatch(owner,[{rowNumber:2,domain:'first-draft.test',about:'A supplied concept for event tracing'}],'first-draft'),claim=(await q.claim('worker'))!;let replayed=false,earlyReplayed=false,earlyReplayError:unknown;
 const checkpoint=q.checkpoint.bind(q);q.checkpoint=async(...args)=>{await checkpoint(...args);if(!earlyReplayed){earlyReplayed=true;try{await checkpoint(...args);}catch(error){earlyReplayError=error;}}if(args[1].stage==='publication'){if((await sites.get(claim.job.siteId))!.draftId){await checkpoint(...args);replayed=true;}}};
 await runJob(claim.job,claim.lease,{sites,queue:q,revisions,artifacts,checkpoints,clock,workspace:join(root,'work'),model:new FakeModel(),publication:{advance:async()=> 'waiting_quota'},templates:{load:async()=>[{path:'index.html',mediaType:'text/html',bytes:Buffer.from('<h1 data-topic>Topic</h1>')}]},validate:async()=>({ok:true,issues:[],screenshotIds:[]})},new AbortController().signal);
 const site=(await sites.get(claim.job.siteId))!;expect(earlyReplayError).toBeUndefined();expect(replayed).toBe(true);expect(site.draftId).toBeTruthy();expect(site.publishedId).toBeNull();expect(site.revision).toBe(0);expect((await revisions.get(site.draftId!))!.kind).toBe('draft');
 await q.cancel(claim.job.id);expect((await sites.get(site.id))!.draftId).toBe(site.draftId);expect(db.sql.prepare('select 1 from operations where site_id=?').get(site.id)).toBeUndefined();await expect(q.heartbeat(claim.lease)).rejects.toMatchObject({code:'STALE_LEASE'});
 } finally {await q.close();await sites.close();await db.close();await rm(root,{recursive:true,force:true});}
});
