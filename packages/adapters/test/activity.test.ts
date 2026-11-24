import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openLocalDatabase} from '../src/local-database.js';
import {createLocalQueue} from '../src/local-queue.js';
import {LocalBatches} from '../src/local-batches.js';
import {ActivityTimer} from '../../../apps/worker/src/activity.js';
it('atomically folds only actual pause/end, retains false-boundary time and exact ambiguous-window replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-activity-')),db=await openLocalDatabase(root),clock={now:()=>1000},queue=await createLocalQueue(root,clock,db),batches=new LocalBatches(db),actor={userId:'owner',role:'user' as const};
 try{const batch=await batches.submitBatch(actor,[{ mentionedUrl: 'https://example.com/', rowNumber:2,domain:'duration.test'}],'activity');let claim=(await queue.claim('worker'))!;let now=0,recordCalls=0;const timer=new ActivityTimer(async s=>{recordCalls++;await queue.recordActivity!(claim.lease,s);},()=>now);
 const original=db.transaction.bind(db);let commits=0;db.transaction=action=>{commits++;return original(action);};
 for(let i=0;i<3;i++){now+=10;expect(await timer.boundary(s=>queue.pauseAtBoundary!(claim.lease,s))).toBe(false);expect(db.sql.prepare('select count(*) n from job_activity').get()!.n).toBe(0);}
 await timer.boundary(async s=>{await queue.finish(claim.lease,'paused',s);return true;});expect(commits).toBe(4);expect(recordCalls).toBe(0);let saved=JSON.parse(String(db.sql.prepare('select data from job_activity').get()!.data));expect(saved.durationMs).toBe(30);
 await queue.retry(claim.job.id);claim=(await queue.claim('worker'))!;let time2=0;const pauseTimer=new ActivityTimer(s=>queue.recordActivity!(claim.lease,s),()=>time2);time2=20;expect(await pauseTimer.boundary(s=>queue.pauseAtBoundary!(claim.lease,s))).toBe(false);await batches.pauseBatch(actor,batch.batchId);time2=40;expect(await pauseTimer.boundary(s=>queue.pauseAtBoundary!(claim.lease,s))).toBe(true);expect((await queue.get(claim.job.id))!.state).toBe('paused');
 await batches.resumeBatch(actor,batch.batchId);claim=(await queue.claim('worker'))!;let time3=0;const pending=new ActivityTimer(async s=>{await queue.recordActivity!(claim.lease,s);throw new Error('acknowledgement lost');},()=>time3);time3=25;await expect(pending.flush()).rejects.toThrow('acknowledgement');time3=35;await pending.boundary(async s=>{await queue.finish(claim.lease,'paused',s);return true;});saved=JSON.parse(String(db.sql.prepare('select data from job_activity').get()!.data));expect(saved.durationMs).toBe(95);expect(saved.sequence).toBe(1);expect(db.sql.prepare('select count(*) n from job_activity').get()!.n).toBe(1);await expect(queue.recordActivity!(claim.lease,{sequence:2,durationMs:1})).rejects.toMatchObject({code:'STALE_LEASE'});
 }finally{await queue.close();await db.close();await rm(root,{recursive:true,force:true});}
});
