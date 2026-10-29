import {importResponse} from '../../contracts/src/import-wire.js';
import {test,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openLocalDatabase} from '../src/local-database.js';import {LocalBatches} from '../src/local-batches.js';
test('batch activity includes off-page work and unadmitted rows but stops for terminal or paused batches',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sf-batch-activity-')),db=await openLocalDatabase(root),b=new LocalBatches(db),owner={userId:'owner',role:'user'} as const;
 try{const batch=await b.submitBatch(owner,Array.from({length:6},(_,i)=>({rowNumber:i+2,domain:'activity-'+i+'.test'})),'activity');
 expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:true});
 db.sql.prepare("update jobs set state='completed',data=json_set(data,'$.state','completed') where id in (select site_id from batch_rows where batch_id=? order by row_number limit 5)").run(batch.batchId);
 expect((await b.page(owner,batch.batchId)).items.every(r=>r.job?.state==='completed')).toBe(true);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:true});
 db.sql.prepare("update jobs set state='completed',data=json_set(data,'$.state','completed') where batch_id=?").run(batch.batchId);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});
 db.sql.prepare("update batch_rows set site_id=null,data=json_set(data,'$.siteId',null,'$.issues',json('[{\"rowNumber\":7,\"column\":\"domain\",\"code\":\"INVALID\",\"message\":\"Invalid row\"}]')) where batch_id=? and row_number=7").run(batch.batchId);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false,invalidCount:1});
 db.sql.prepare("update batch_rows set data=json_set(data,'$.issues',json('[]')) where batch_id=? and row_number=7").run(batch.batchId);
 db.sql.prepare("update batch_rows set site_id=null,data=json_set(data,'$.siteId',null) where batch_id=? and row_number=7").run(batch.batchId);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:true});
 const draft=b.read(owner,batch.batchId);draft.summary.state='preview';b.save(draft);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});draft.summary.state='active';b.save(draft);
 await b.pauseBatch(owner,batch.batchId);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});await b.cancelBatch(owner,batch.batchId);expect(await b.get(owner,batch.batchId)).toMatchObject({activeWork:false});
 await expect(b.get({userId:'foreign',role:'user'},batch.batchId)).rejects.toMatchObject({code:'NOT_FOUND'});
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});

test('optional activity projection is a bounded boolean in the import wire',()=>{const summary={id:'11111111-1111-4111-8111-111111111111',name:'rows.csv',revision:1,state:'active',total:1,validCount:1,invalidCount:0,canControl:false};expect(importResponse('batch.get',{...summary,activeWork:true})).toMatchObject({activeWork:true});expect(importResponse('batch.get',summary)).toEqual(summary);expect(()=>importResponse('batch.get',{...summary,activeWork:'true'})).toThrow();});
