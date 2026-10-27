import {test,expect} from 'vitest';
import {createApp} from '../../apps/control/src/app.js';
import {database,identities,seedUsers} from './database.js';
import {SupabaseRepository} from '../../packages/adapters/src/supabase-repository.js';
import type {LeaseAuthority} from '../../packages/adapters/src/supabase-repository.js';
import {R2Store,R2Transport,metadata,prepareInput} from '../../packages/adapters/src/r2-store.js';
import type {ObjectTransport} from '../../packages/adapters/src/r2-store.js';
import {S3Client} from '@aws-sdk/client-s3';
import {AppError} from '../../packages/contracts/src/model.js';
import type {Lease} from '../../packages/contracts/src/model.js';
import {randomUUID} from 'node:crypto';
import {tokenHash} from '../../apps/control/src/auth.js';
import {chromium} from '@playwright/test';
import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
test.skip('real R2 signed-header/conditional-collision/anonymous-GET acceptance requires an authorized private test bucket',()=>{});
class FixtureStorage implements ObjectTransport {
 objects=new Map<string,{bytes:Uint8Array;mediaType:string}>();afterRead:(()=>Promise<void>)|undefined;
 async signPut(key:string){return 'https://storage.test/'+key;}
 async put(key:string,bytes:Uint8Array,mediaType:string){if(this.objects.has(key))throw new Error('412 immutable');this.objects.set(key,{bytes:bytes.slice(),mediaType});}
 async head(key:string){const f=this.objects.get(key)!;return {size:f.bytes.length,mediaType:f.mediaType};}
 async get(key:string){await this.afterRead?.();return this.objects.get(key)!.bytes;}
}
// Deliberately test-only transaction authority, not the Task8 production queue implementation.
function fixtureAuthority():LeaseAuthority{return {async assertCurrent(tx,workerId,lease){const info=(await tx.query('select site_id from private.jobs where id=$1',[lease.jobId])).rows[0];if(!info)throw new AppError('STALE_LEASE','fixture');await tx.query('select id from public.sites where id=$1 for update',[info.site_id]);const worker=(await tx.query('select revoked_at from private.workers where id=$1 for update',[workerId])).rows[0];const job=(await tx.query('select *,expires_at>clock_timestamp() fresh from private.jobs where id=$1 for update',[lease.jobId])).rows[0];const admission=(await tx.query('select * from private.site_operations where site_id=$1 for update',[info.site_id])).rows[0];if(!worker||worker.revoked_at||job.worker_id!==workerId||job.data.state!=='running'||!job.fresh||Number(job.generation)!==lease.generation||admission.operation_id!==job.id||Number(admission.generation)!==lease.generation)throw new AppError('STALE_LEASE','fixture');return {jobId:job.id,siteId:info.site_id,generation:Number(job.generation)};}};}
test('worker credentials required even when managed lease authority is unavailable',async()=>{
 const app=createApp({});
 const response=await app(new Request('https://control.test/uploads/prepare',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
 expect(response.status).toBe(401);
});
test('shared editing transitions accept verified evidence and scoped preview never exposes checkpoints',async()=>{
 const pool=await database();try{await seedUsers(pool);const repo=new SupabaseRepository(pool),storage=new FixtureStorage(),store=new R2Store(repo,storage,fixtureAuthority());const actor={userId:identities.spec,role:'spec-user' as const};
 const initial=await repo.create({domain:'editing.example'},actor),base=await store.put(initial.id,[{path:'index.html',mediaType:'text/html',bytes:Buffer.from('<h1>Initial</h1>')}],'1.0.0'),revision=randomUUID();await pool.query("insert into revisions values($1,$2,null,$3,'published',1)",[revision,initial.id,base.id]);await pool.query('update sites set published_id=$2 where id=$1',[initial.id,revision]);await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1",[initial.id]);
 const app=createApp({repository:repo,store,previewKey:Buffer.alloc(32,7),publicOrigin:'https://control.test',auth:{verifyUser:async()=>actor,verifyWorker:async()=>{throw new Error('unused fixture');}}});
 const request=(path:string,method='GET',body?:unknown)=>app(new Request('https://control.test'+path,{method,headers:{authorization:'Bearer fixture-user','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const edit=await request(`/sites/${initial.id}/edits`,'POST',{instruction:'Change title',expectedRevision:0});expect(edit.status).toBe(200);const jobView=await edit.json(),candidate=(await repo.editingState(initial.id)).candidates[0]!,job=candidate.job;
 const workerId=randomUUID(),workerToken='a'.repeat(43);await pool.query('insert into private.workers(id,name,token_hash) values($1,$2,$3)',[workerId,'fixture',tokenHash(workerToken)]);await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"running\"'),worker_id=$2,generation=1,expires_at=clock_timestamp()+interval '120 seconds' where id=$1",[job.id,workerId]);await pool.query('update private.site_operations set generation=1 where site_id=$1',[initial.id]);
 const files=[{path:'index.html',mediaType:'text/html',bytes:Buffer.from('<link rel="stylesheet" href="site.css"><h1>Changed</h1>')},{path:'site.css',mediaType:'text/css',bytes:Buffer.from('h1{color:rgb(12,34,56)}')}],artifact=await store.put(initial.id,files,'1.0.0');const lease={jobId:job.id,workerId,generation:1,expiresAt:0};const checkpoint=await store.save({...job,stage:'publication'},lease,{jobId:job.id,siteId:initial.id,baseRevision:0,revisionId:candidate.id,manifestId:artifact.id,baseManifestId:base.id,parentRevisionId:revision,validation:{ok:true,issues:[],screenshotIds:[]},selection:{seed:1,styleId:'fixture',templateVersion:'1.0.0'},transcript:[{summary:'Changed safely.'}],continuation:{private:'PRIVATE_REPLAY'}},files);
 await pool.query('update private.jobs set data=$2,checkpoint_id=$3,worker_id=null,expires_at=null where id=$1',[job.id,{...job,state:'completed',stage:'publication',checkpointId:checkpoint.id},checkpoint.id]);
 expect((await (await request(`/sites/${initial.id}/candidates`)).json()).candidates[0].status).toBe('ready');
 const accepted=await request(`/sites/${initial.id}/candidates/${candidate.id}/accept`,'POST',{expectedRevision:0});expect(accepted.status).toBe(200);expect((await accepted.json()).draftId).toBe(candidate.id);expect((await repo.get(initial.id))!.publishedId).toBe(revision);
 expect((await request(`/sites/${initial.id}/candidates/${candidate.id}/accept`,'POST',{expectedRevision:0})).status).toBe(200);
 await expect(pool.query("update revisions set kind='published' where id=$1",[candidate.id])).rejects.toThrow('immutable record');
 const grant=await request(`/sites/${initial.id}/revisions/${candidate.id}/preview`);expect(grant.status).toBe(200);const url=(await grant.json()).url;expect(url).not.toContain(workerToken);const redirect=await app(new Request(url));expect(redirect.status).toBe(303);const cookie=redirect.headers.get('set-cookie')!.split(';')[0]!;expect(redirect.headers.get('location')).not.toContain('cap=');
 const resource=await app(new Request('https://control.test'+redirect.headers.get('location'),{headers:{cookie}}));expect(resource.status).toBe(200);const projectedHtml=await resource.text();expect(projectedHtml).toContain('Changed');expect(resource.headers.get('content-security-policy')).toContain("connect-src 'none'");
 const assetUrl='https://control.test'+/href="([^"]*site\.css[^\"]*)"/.exec(projectedHtml)![1];expect((await app(new Request(assetUrl))).status).toBe(200);expect((await app(new Request(assetUrl.replace('/site.css?','/index.html?')))).status).toBe(403);expect((await app(new Request(assetUrl.replace(candidate.id,randomUUID())))).status).toBe(403);
 expect(Buffer.from((await store.read(artifact.id))[0]!.bytes).toString()).not.toContain('?asset=');
 expect((await app(new Request('https://control.test'+redirect.headers.get('location')))).status).toBe(401);
 // Real Chromium cookie/redirect behavior, including cross-site navigation in a new tab.
 // Actual ephemeral HTTPS server, no managed provider; only the cross-site initiator is intercepted.
 let assetCookie=false,assetCapability=false,assetRequested=false;
 const server=createServer({cert:await readFile(process.env.SITE_FACTORY_TEST_TLS_CERT!),key:await readFile(process.env.SITE_FACTORY_TEST_TLS_KEY!)},async(incoming,outgoing)=>{try{const headers=new Headers();for(const [name,value]of Object.entries(incoming.headers))if(value)headers.set(name,Array.isArray(value)?value.join(','):value);const target=new URL('https://control.test'+incoming.url);if(target.pathname.endsWith('site.css')){assetRequested=true;assetCookie=!!incoming.headers.cookie;assetCapability=target.searchParams.has('asset')&&!incoming.headers.authorization;}const response=await app(new Request(target,{headers}));outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));}catch{outgoing.writeHead(500);outgoing.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{for(const blocked of [false,true]){assetRequested=false;const browser=await chromium.launch({headless:true,args:blocked?['--test-third-party-cookie-phaseout','--disable-features=TpcdHeuristicsGrants,TpcdMetadataGrants']:[]});
 try{const context=await browser.newContext({ignoreHTTPSErrors:true}),browserUrl=url.replace('https://control.test',`https://127.0.0.1:${(server.address() as AddressInfo).port}`);
 await context.route('https://initiator.test/**',route=>route.fulfill({contentType:'text/html',body:`<a target="_blank" href="${browserUrl}">Preview</a>`}));
 const initiator=await context.newPage();await initiator.goto('https://initiator.test');const [popup]=await Promise.all([initiator.waitForEvent('popup'),initiator.getByText('Preview').click()]);await popup.waitForLoadState('load');expect(await popup.locator('h1').textContent({timeout:5000})).toBe('Changed');expect(await popup.locator('h1').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(12, 34, 56)');expect(popup.url()).not.toContain('cap=');expect(assetRequested&&assetCapability).toBe(true);expect((await context.cookies()).some(c=>c.name==='sf_preview')).toBe(true);if(blocked)expect(assetCookie).toBe(false);
 }finally{await browser.close();}}}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 expect((await request(`/sites/${initial.id}/revisions/${checkpoint.id}/preview`)).status).toBe(404);
 const foreign=await repo.create({domain:'foreign.example'},actor);expect((await app(new Request(url.replace(initial.id,foreign.id)))).status).toBe(403);
 await pool.query('update memberships set active=false where user_id=$1',[actor.userId]);expect((await app(new Request('https://control.test'+redirect.headers.get('location'),{headers:{cookie}}))).status).toBe(403);
 expect(JSON.stringify(await (await request(`/sites/${initial.id}/candidates`)).json())).not.toContain('PRIVATE_REPLAY');expect(jobView.edit).toBeUndefined();
 }finally{await pool.end();}
});
test('R2 presigner signs Content-Type and conditional PUT for exactly ten minutes',async()=>{
 const transport=new R2Transport(new S3Client({region:'auto',endpoint:'https://fixture.r2.cloudflarestorage.com',credentials:{accessKeyId:'fixture',secretAccessKey:'fixture-secret'}}),'private-fixture');
 const url=new URL(await transport.signPut('private/artifacts/immutable/file','text/html'));
 expect(url.searchParams.get('X-Amz-Expires')).toBe('600');expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(expect.arrayContaining(['content-type','if-none-match']));
});
test('real SQL upload lifecycle binds lease and immutable keys, checks actual bytes and fences late completion',async()=>{
 const pool=await database();try{await seedUsers(pool);const repo=new SupabaseRepository(pool),storage=new FixtureStorage(),store=new R2Store(repo,storage,fixtureAuthority());
 const site=await repo.create({domain:'uploads.example'},{userId:identities.spec,role:'spec-user'}),workerId=randomUUID();await pool.query('insert into private.workers(id,name,token_hash) values($1,$2,$3)',[workerId,'fixture','a'.repeat(64)]);
 const lease:Lease={jobId:site.id,workerId,generation:1,expiresAt:1};await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"running\"'),worker_id=$2,generation=1,expires_at=clock_timestamp()+interval '120 seconds' where id=$1",[site.id,workerId]);await pool.query('update private.site_operations set generation=1 where site_id=$1',[site.id]);
 const file={path:'index.html',mediaType:'text/html',bytes:Buffer.from('<html>verified</html>')},input={lease,purpose:'artifact' as const,templateVersion:'1.0.0',files:[metadata(file)],expectedCheckpointId:null};
 expect(()=>prepareInput({...input,objectKey:'foreign'})).toThrow();expect(()=>prepareInput({...input,files:[{...metadata(file),path:'../private.html'}]})).toThrow();expect(()=>prepareInput({...input,files:[metadata(file),{...metadata(file),path:'INDEX.HTML'}]})).toThrow();
 const prep=await store.prepare(workerId,input);expect(prep.expiresAt-Date.now()).toBeGreaterThan(590000);expect(prep.files[0]!.headers).toEqual({'content-type':'text/html','if-none-match':'*'});expect(prep.files[0]!.objectKey).toContain('/private/'.slice(1));
 await storage.put(prep.files[0]!.objectKey,Buffer.alloc(file.bytes.length,120),file.mediaType);await expect(store.complete(workerId,prep.uploadId,lease)).rejects.toMatchObject({code:'INVALID_INPUT'});expect((await pool.query('select * from private.artifacts')).rows).toHaveLength(0);
 const valid=await store.prepare(workerId,input);await storage.put(valid.files[0]!.objectKey,file.bytes,file.mediaType);const done=await store.complete(workerId,valid.uploadId,lease);expect(await store.complete(workerId,valid.uploadId,lease)).toEqual(done);expect(Buffer.from((await store.read(done.manifestId!))[0]!.bytes)).toEqual(file.bytes);await expect(storage.put(valid.files[0]!.objectKey,file.bytes,file.mediaType)).rejects.toThrow('412');
 const state={jobId:site.id,siteId:site.id,baseRevision:0,manifestId:done.manifestId,continuation:{private:'PRIVATE_REPLAY'}},stateFile={path:'state.json',mediaType:'application/json',bytes:Buffer.from(JSON.stringify(state))};
 const checkpoint=await store.prepare(workerId,{...input,purpose:'checkpoint',stage:'publication',state:metadata(stateFile)});await storage.put(checkpoint.files[0]!.objectKey,file.bytes,file.mediaType);await storage.put(checkpoint.files[1]!.objectKey,stateFile.bytes,stateFile.mediaType);const complete=await store.complete(workerId,checkpoint.uploadId,lease);expect((await store.load(complete.checkpointId!)).state).toEqual(state);expect((await pool.query('select checkpoint_id from private.jobs where id=$1',[site.id])).rows[0].checkpoint_id).toBeNull();await expect(store.read(complete.checkpointId!)).rejects.toMatchObject({code:'NOT_FOUND'});
 const delayed=await store.prepare(workerId,input);await storage.put(delayed.files[0]!.objectKey,file.bytes,file.mediaType);await pool.query("update private.jobs set checkpoint_id=$2,data=jsonb_set(data,'{checkpointId}',to_jsonb(($2::uuid)::text)) where id=$1",[site.id,complete.checkpointId]);await expect(store.complete(workerId,delayed.uploadId,lease)).rejects.toMatchObject({code:'CONFLICT'});expect((await pool.query('select 1 from private.artifacts where id=$1',[delayed.uploadId])).rowCount).toBe(0);expect(await store.complete(workerId,checkpoint.uploadId,lease)).toEqual(complete);await expect(store.prepare(workerId,input)).rejects.toMatchObject({code:'CONFLICT'});
 const late=await store.prepare(workerId,{...input,expectedCheckpointId:complete.checkpointId});await storage.put(late.files[0]!.objectKey,file.bytes,file.mediaType);storage.afterRead=async()=>{storage.afterRead=undefined;await pool.query('update private.workers set revoked_at=clock_timestamp() where id=$1',[workerId]);};await expect(store.complete(workerId,late.uploadId,lease)).rejects.toMatchObject({code:'STALE_LEASE'});expect((await pool.query('select completed_at from private.upload_preparations where id=$1',[late.uploadId])).rows[0].completed_at).toBeNull();
 await expect(store.prepare(workerId,input)).rejects.toMatchObject({code:'STALE_LEASE'});await pool.query('update private.workers set revoked_at=null where id=$1',[workerId]);await pool.query("update private.jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[site.id]);await expect(store.prepare(workerId,{...input,lease:{...lease,expiresAt:Date.now()+99999999}})).rejects.toMatchObject({code:'STALE_LEASE'});
 }finally{await pool.end();}
});
