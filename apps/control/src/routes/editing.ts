import {randomUUID} from 'node:crypto';
import {createEditing} from '../../../../packages/core/src/editing.js';
import {candidateView,jobView,siteView,object,string,uuid,integer} from '../../../../packages/contracts/src/http.js';
import type {Principal} from '../../../../packages/contracts/src/model.js';
import {AppError} from '../../../../packages/contracts/src/model.js';
import type {SupabaseRepository,Admission} from '../../../../packages/adapters/src/supabase-repository.js';
import type {R2Store} from '../../../../packages/adapters/src/r2-store.js';
import {unavailable} from '../errors.js';
export function editingFor(repo:SupabaseRepository,store:R2Store|undefined,admission:Admission){
 const checkpoints=store??{save:async()=>unavailable(),load:async()=>unavailable()};
 return createEditing({...(store?{artifacts:store}:{}),visualCompareAndSet:(actorId,id,rev,draftId)=>repo.compareAndSet(id,rev,{draftId},admission,actorId),sites:{create:(input,p)=>repo.create(input,p),list:(p,c,l)=>repo.list(p,c,l),get:id=>repo.get(id),compareAndSet:(id,rev,patch)=>repo.compareAndSet(id,rev,patch,admission)},store:repo.editingStore(admission),revisions:{get:id=>repo.revision(id),put:r=>repo.putRevision(r,admission)},queue:repo.queue(admission),checkpoints,publication:{advance:async()=>unavailable()},ids:{next:randomUUID},clock:{now:Date.now}});
}
export async function editingRoute(repo:SupabaseRepository,store:R2Store|undefined,actor:Principal,request:Request,path:string,body:unknown){
 const match=/^\/sites\/([^/]+)\/(edits|candidates|chat|history|publish|export)(?:\/([^/]+)\/(accept|reject))?$/.exec(path);if(!match)return undefined;
 const siteId=uuid(match[1]),kind=match[2];await repo.scoped(actor,siteId,kind==='export'?'site:export':kind==='publish'?'site:publish':request.method==='GET'?'site:read':'site:edit');
 if(kind==='publish'||kind==='export')return unavailable();
 if(request.method==='GET'){
  // Active worker/controller ownership yields a read-only projection. Idle sites may reconcile
  // using the same domain transitions as local editing, fenced at every individual write.
  if(actor.role!=='user'&&['candidates','chat'].includes(kind!)){
   let admission:Admission|undefined;
   try{admission=await repo.acquire(actor,siteId);await editingFor(repo,store,admission).recover(siteId);}
   catch(error){if(!(error instanceof AppError&&['CONFLICT','STALE_LEASE'].includes(error.code)))throw error;}
   finally{if(admission)await repo.release(admission);}
  }
  const state=await repo.editingState(siteId);
  if(kind==='chat')return state.messages.map(({id,role,text,createdAt})=>({id,role,text,createdAt}));
  if(kind==='history')return (await repo.pool.query("select r.id,r.parent_id,r.kind,r.created_at,(s.published_id=r.id) published from public.revisions r join public.sites s on s.id=r.site_id where r.site_id=$1 order by created_at desc,id",[siteId])).rows.map(r=>({id:r.id,parentId:r.parent_id,kind:r.kind,createdAt:Number(r.created_at),published:r.published}));
  if(kind==='candidates')return {candidates:await Promise.all(state.candidates.map(async c=>{const j=(await repo.pool.query('select data from private.jobs where id=$1',[c.jobId])).rows[0]?.data??c.job;return candidateView({...c,job:j});})),publication:state.publications.at(-1)??null};return undefined;
 }
 if(request.method!=='POST')return undefined;
 const admission=await repo.acquire(actor,siteId);
 try {
  const editing=editingFor(repo,store,admission);
  if(kind==='edits'){const p=object(body,['instruction','expectedRevision','candidateId']);return jobView(await editing.requestEdit(actor,siteId,string(p.instruction,8000),integer(p.expectedRevision),p.candidateId===undefined?undefined:uuid(p.candidateId)));}
  if(match[4]==='accept'){const p=object(body,['expectedRevision']);return siteView({...await editing.acceptCandidate(actor,siteId,uuid(match[3]),integer(p.expectedRevision)),job:null});}
  if(match[4]==='reject'){object(body,[]);await editing.rejectCandidate(actor,siteId,uuid(match[3]));return {ok:true};}
  return undefined;
 }finally{await repo.release(admission);}
}
