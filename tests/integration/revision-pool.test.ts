import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {database,seedUsers,identities} from './database.js';
import {SupabaseRepository} from '../../packages/adapters/src/supabase-repository.js';
import type {Revision} from '../../packages/contracts/src/model.js';
test('revision persistence and exact replay use the held transaction with a one-connection pool',async()=>{
 // A nested pool checkout must reject within one second rather than hanging cleanup.
 const pool=await database({max:1,connectionTimeoutMillis:1000,statement_timeout:2000});
 try{
  await seedUsers(pool);const repo=new SupabaseRepository(pool),actor={userId:identities.admin,role:'admin' as const};
  const site=await repo.create({domain:'one-connection.example'},actor);
  await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1",[site.id]);
  const admission=await repo.acquire(actor,site.id),manifestId=randomUUID();
  await pool.query('insert into private.artifacts values($1,$2,$3,true)',[manifestId,site.id,{}]);
  const revision:Revision={id:randomUUID(),siteId:site.id,parentId:null,manifestId,kind:'candidate',createdAt:1};
  await repo.putRevision(revision,admission);
  await repo.putRevision(revision,admission);
  expect(await repo.revision(revision.id)).toEqual(revision);
  await expect(repo.putRevision({...revision,createdAt:2},admission)).rejects.toMatchObject({code:'CONFLICT'});
  expect((await pool.query('select count(*)::int n from public.revisions')).rows[0].n).toBe(1);
  await repo.release(admission);
 }finally{await pool.end();}
},10000);
