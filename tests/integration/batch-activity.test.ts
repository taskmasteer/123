import type {ImportPage} from '../../packages/contracts/src/import.js';
import {test,expect} from 'vitest';import {database,seedUsers,identities} from './database.js';
import {SupabaseRepository} from '../../packages/adapters/src/supabase-repository.js';import {PostgresBatches} from '../../packages/adapters/src/postgres-batches.js';
test('batch activity covers off-page work and unadmitted rows while terminal and paused batches stop',async()=>{
 const pool=await database();try{await seedUsers(pool);const b=new PostgresBatches(new SupabaseRepository(pool)),owner={userId:identities.user,role:'user'} as const,batch=await b.submitBatch(owner,Array.from({length:6},(_,i)=>({rowNumber:i+2,mentionedUrl:'https://example.com/guide',domain:'activity-'+i+'.test'})),'activity');
 expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:true});
 await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id in (select site_id from private.batch_rows where batch_id=$1 order by row_number limit 5)",[batch.batchId]);
 expect((await b.request(owner,'batch.rows',{id:batch.batchId}) as ImportPage).items.every(r=>r.job?.state==='completed')).toBe(true);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:true});
 await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where batch_id=$1",[batch.batchId]);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});
 await pool.query("update private.batch_rows set site_id=null,data=jsonb_set(jsonb_set(data,'{siteId}','null'),'{issues}',$2::jsonb) where batch_id=$1 and row_number=7",[batch.batchId,JSON.stringify([{rowNumber:7,column:'domain',code:'INVALID',message:'Invalid row'}])]);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false,invalidCount:1});
 await pool.query("update private.batch_rows set data=jsonb_set(data,'{issues}','[]') where batch_id=$1 and row_number=7",[batch.batchId]);
 await pool.query("update private.batch_rows set site_id=null,data=jsonb_set(data,'{siteId}','null') where batch_id=$1 and row_number=7",[batch.batchId]);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:true});
 const draft=await b.read(pool,owner,batch.batchId);draft.summary.state='preview';await b.repository.transaction(tx=>b.save(tx,draft));expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});draft.summary.state='active';await b.repository.transaction(tx=>b.save(tx,draft));
 await b.request(owner,'batch.pause',{id:batch.batchId});expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});await b.request(owner,'batch.cancel',{id:batch.batchId});expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});
 await expect(b.get({userId:identities.spec,role:'spec-user'},batch.batchId)).rejects.toMatchObject({code:'NOT_FOUND'});
 }finally{await pool.end();}
});
