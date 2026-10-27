import {randomUUID,randomBytes} from 'node:crypto';
import {authorize} from '../../../../packages/core/src/permissions.js';
import type {Principal} from '../../../../packages/contracts/src/model.js';
import {object,string,uuid} from '../../../../packages/contracts/src/http.js';
import type {SupabaseRepository} from '../../../../packages/adapters/src/supabase-repository.js';
import {tokenHash} from '../auth.js';
export async function workersRoute(repo:SupabaseRepository,actor:Principal,request:Request,path:string,body:unknown){if(!path.startsWith('/workers'))return undefined;authorize(actor,'admin:manage');
 if(path==='/workers'&&request.method==='GET')return (await repo.pool.query('select id,name,revoked_at is not null revoked from private.workers order by id')).rows;
 if(path==='/workers/enroll'&&request.method==='POST'){const p=object(body,['name']),name=string(p.name,100),id=randomUUID(),token=randomBytes(32).toString('base64url');await repo.transaction(async tx=>{authorize(await repo.fresh(tx,actor),'admin:manage');await tx.query('insert into private.workers(id,name,token_hash) values($1,$2,$3)',[id,name,tokenHash(token)]);});return {workerId:id,token};}
 const revoke=/^\/workers\/([^/]+)\/revoke$/.exec(path);if(revoke&&request.method==='POST'){object(body,[]);await repo.transaction(async tx=>{authorize(await repo.fresh(tx,actor),'admin:manage');await tx.query('update private.workers set revoked_at=clock_timestamp() where id=$1',[uuid(revoke[1])]);});return {ok:true};}return undefined;}
