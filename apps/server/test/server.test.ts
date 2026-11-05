import {createHosting} from '../src/hosting.js';
import { beforeAll, afterAll, test, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID,createHash } from 'node:crypto';
import { resolve,join } from 'node:path';
import { readFile,mkdir,writeFile,rm } from 'node:fs/promises';
import { migrate } from '../src/migrate.js';
import { protectSecret } from '../src/secrets.js';
import { createServerRuntime,type ServerRuntime } from '../src/runtime.js';
import { createHttpHandler } from '../src/http.js';
import { FakeModel } from '../../../packages/adapters/src/fake-model.js';
import type { ModelPort,Site } from '../../../packages/contracts/src/model.js';

const enabled=process.env.SITE_FACTORY_SERVER_TEST==='1';
let admin:Pool,pool:Pool,runtime:ServerRuntime,handler:ReturnType<typeof createHttpHandler>,cookie='',csrf='',userId='';
const db='sf_test_'+randomUUID().replaceAll('-',''),root=resolve('.'),data=resolve('.local-state',db),origin='http://127.0.0.1:4312';
export const fixtureModel:ModelPort={identity:'fixture:server',async run(request,tools,signal){
  const result=await new FakeModel().run(request,tools,signal);
  if(request.mode==='generate'&&request.site.input.mentionedUrl){let html=await tools.read('index.html');html=html.replace('</main>',`<section data-mentioned-link="true"><h2>Explore the resource</h2><p>This resource contains practical documentation for building reliable websites. Visit it for further reading and examples relevant to this project.</p><a href="${request.site.input.mentionedUrl}">Read the documentation</a></section></main>`);await tools.write('index.html',html);}
  return result;
}};
beforeAll(async()=>{if(!enabled)return;const config=JSON.parse((await readFile('.local-state/server/config.json','utf8')).replace(/^\uFEFF/,''));const connection={host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true)};admin=new Pool({...connection,database:'postgres'});await admin.query('create database '+db);pool=new Pool({...connection,database:db,max:10});await mkdir(data,{recursive:true});await migrate(pool,root);runtime=await createServerRuntime(pool,root,data,origin,fixtureModel);await runtime.hosting.close();runtime.hosting=await createHosting(pool,runtime.repository,runtime.store,data,{publish:async()=>{},dns:{read:async domain=>({domain,records:[]}),write:async()=>{}},propagated:async()=>true,health:async()=>{}});await pool.query("insert into factory.hosting_addresses(address,host_id) values('192.0.2.50','fixture')");runtime.repository.beforeBatchCommit=runtime.hosting.prepareBatch;runtime.repository.canAdmitBatchSite=runtime.hosting.canAdmitBatchSite;runtime.repository.onBatchSiteCreated=runtime.hosting.reserveBatchSite;await pool.query("insert into factory.hosting_addresses(address,host_id) values('192.0.2.51','fixture')");handler=createHttpHandler(runtime,origin,resolve('apps/desktop/dist-web'));},60000);
afterAll(async()=>{if(!enabled)return;await runtime?.hosting.close();await runtime?.close();await pool?.end();if(admin){await admin.query('drop database '+db);await admin.end();}},30000);
async function call(path:string,body?:unknown,authenticated=true){const headers:Record<string,string>={'origin':origin,'content-type':'application/json',...(authenticated?{cookie,'x-csrf-token':csrf}:{})};return handler(new Request(origin+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})}));}
test.skipIf(!enabled)('registration, invitation, full access and revoked sessions',async()=>{
  const remoteStatus=await handler(new Request(origin+'/auth/status'),'198.51.100.2');expect((await remoteStatus.json()).bootstrap).toBe(false);
  const remoteRegistration=await handler(new Request(origin+'/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({login:'remote_owner',password:'test-only-password-123',invite:''})}),'198.51.100.2');expect(remoteRegistration.status).toBe(403);
  expect((await call('/auth/register',{login:'user@example.test',password:'test-only-password-123',invite:''},false)).status).toBe(400);
  expect((await call('/auth/register',{email:'user@example.test',password:'test-only-password-123',invite:''},false)).status).toBe(400);
  const registration=await call('/auth/register',{login:'owner',password:'test-only-password-123',invite:''},false);expect(registration.status).toBe(200);cookie=registration.headers.get('set-cookie')!.split(';')[0]!;const account=await registration.json();csrf=account.user.csrf;userId=account.user.id;
  expect(account.user.login).toBe('owner');expect(account.user).not.toHaveProperty('email');
  const signedIn=await call('/auth/login',{login:' OWNER ',password:'test-only-password-123'},false);expect(signedIn.status).toBe(200);expect((await signedIn.json()).user.login).toBe('owner');
  expect((await call('/auth/login',{login:'owner',password:'incorrect-password'},false)).status).toBe(401);
  const duplicateInvite=await (await call('/api/invitations',{login:'OWNER'})).json();
  expect((await call('/auth/register',{login:'OWNER',password:'test-only-password-123',invite:duplicateInvite.code},false)).status).toBe(409);
  expect((await pool.query('select email from public.users where id=$1',[userId])).rows[0].email).toBeNull();
  const unauthorized=await call('/api/sites',undefined,false);expect(unauthorized.status).toBe(401);
  const rejected=await handler(new Request(origin+'/api/invitations',{method:'POST',headers:{cookie,origin:'https://untrusted.example','content-type':'application/json'},body:'{}'}));expect(rejected.status).toBe(403);
  const missingCsrf=await handler(new Request(origin+'/api/invitations',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'}));expect(missingCsrf.status).toBe(403);
  const invite=await (await call('/api/invitations',{login:'member'})).json();
  expect((await call('/auth/register',{login:'wrong',password:'test-only-password-123',invite:invite.code},false)).status).toBe(403);
  const registered=await call('/auth/register',{login:'member',password:'test-only-password-123',invite:invite.code},false);expect(registered.status).toBe(200);const member=await registered.json(),memberCookie=registered.headers.get('set-cookie')!.split(';')[0]!;
  expect((await call('/auth/register',{login:'member2',password:'test-only-password-123',invite:invite.code},false)).status).toBe(403);
  const session=await handler(new Request(origin+'/api/session',{headers:{cookie:memberCookie}}));expect((await session.json()).principal.role).toBe('admin');
  expect((await call('/api/accounts/status',{id:member.user.id,active:false})).status).toBe(200);
  expect((await handler(new Request(origin+'/api/session',{headers:{cookie:memberCookie}}))).status).toBe(401);
  const stored=(await pool.query('select password_hash from factory.accounts where id=$1',[userId])).rows[0].password_hash;expect(stored).not.toContain('test-only-password');
},20000);
test.skipIf(!enabled)('server generation persists a checked draft and preview without publication',async()=>{
  const created=await call('/api/sites',{domain:'server-fixture.example',about:'A reliable developer documentation concept',referenceId:'corporate',mentionedUrl:'https://www.example.com/guide',mentionedDescription:'A documentation resource with practical examples.'});const result=await created.json();expect(created.status,JSON.stringify(result)).toBe(200);const id=result.id;
  let site:Site&{job?:{state:string}}=result;
  const deadline=Date.now()+45000;while(Date.now()<deadline){site=await (await call('/api/sites/'+id)).json();if(['completed','needs_attention'].includes(site.job?.state??''))break;await new Promise(r=>setTimeout(r,300));}
  if(site.job?.state==='needs_attention'){const job=(await pool.query('select data from private.jobs where site_id=$1',[id])).rows[0].data;const checkpoint=await runtime.store.load(job.checkpointId);throw new Error(JSON.stringify({error:checkpoint.state.error,validation:checkpoint.state.validation}));}
  expect(site.job?.state,JSON.stringify({site,status:runtime.status()})).toBe('completed');expect(site.draftId).toBeTruthy();expect(site.publishedId).toBeNull();
  const initialHistory=await (await call(`/api/sites/${id}/draft-history`)).json();expect(initialHistory.items[0].id).toBe(site.draftId);expect(initialHistory.items[0].current).toBe(true);
  const preview=await (await call(`/api/sites/${id}/revisions/${site.draftId}/preview`)).json();const response=await handler(new Request(preview.url));expect(response.status).toBe(200);const html=await response.text();expect(html).toContain('data-mentioned-link');expect(html).toContain('https://www.example.com/guide');expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect((await pool.query('select 1 from private.publication_reservations')).rowCount).toBe(0);
  const downloadPath=`/api/sites/${id}/download?revisionId=${site.draftId}`;
  expect((await call(downloadPath,undefined,false)).status).toBe(401);
  const zip=await call(downloadPath);expect(zip.status).toBe(200);expect(Buffer.from(await zip.arrayBuffer()).subarray(0,4)).toEqual(Buffer.from([80,75,3,4]));
  const source=await call(downloadPath+'&path=index.html');expect(source.status).toBe(200);expect(await source.text()).toContain('data-mentioned-link');
  expect((await call(`/api/sites/${randomUUID()}/download?revisionId=${site.draftId}`)).status).not.toBe(200);
  await runtime.close();runtime=await createServerRuntime(pool,root,data,origin,fixtureModel);await runtime.hosting.close();runtime.hosting=await createHosting(pool,runtime.repository,runtime.store,data,{publish:async()=>{},dns:{read:async domain=>({domain,records:[]}),write:async()=>{}},propagated:async()=>true,health:async()=>{}});runtime.repository.beforeBatchCommit=runtime.hosting.prepareBatch;runtime.repository.canAdmitBatchSite=runtime.hosting.canAdmitBatchSite;runtime.repository.onBatchSiteCreated=runtime.hosting.reserveBatchSite;handler=createHttpHandler(runtime,origin,resolve('apps/desktop/dist-web'));
  const reopened=await (await call('/api/sites/'+id)).json();expect(reopened.draftId).toBe(site.draftId);expect((await call('/api/session')).status).toBe(200);
  expect((await call(`/api/sites/${id}/edits`,{instruction:'Disabled',expectedRevision:site.revision})).status).toBe(403);
  expect((await call('/api/sites',{domain:'missing-link.example'})).status).toBe(400);
  expect((await call('/api/sites/'+id+'/diagnostic',undefined,false)).status).toBe(401);expect(await (await call('/api/sites/'+id+'/diagnostic')).json()).toBeNull();
  const previewReference=await (await call('/api/reference-preview/folio')).json();expect(previewReference.ready).toBe(true);expect(previewReference.image).toMatch(/^data:image\/jpeg;base64,/);

},90000);
test.skipIf(!enabled)('registration keys expire after twenty minutes and cannot be reused',async()=>{
  const invite=await (await call('/api/invitations',{})).json();expect(invite.expiresInMinutes).toBe(20);
  expect(Date.parse(invite.expiresAt)-Date.now()).toBeGreaterThan(19*60000);expect(Date.parse(invite.expiresAt)-Date.now()).toBeLessThanOrEqual(20*60000+100);
  const check=await call('/auth/invitation',{code:invite.code},false);expect(check.status).toBe(200);expect((await check.json()).valid).toBe(true);
  const attempts=await Promise.all(['new_member','other_member'].map(login=>call('/auth/register',{login,password:'test-only-password-123',invite:invite.code},false)));
  expect(attempts.map(r=>r.status).sort()).toEqual([200,403]);expect((await call('/auth/invitation',{code:invite.code},false)).status).toBe(403);
  const expired=await (await call('/api/invitations',{})).json();await pool.query("update factory.invites set expires_at=now()-interval '1 second' where hash=$1",[createHash('sha256').update(expired.code).digest('hex')]);
  expect((await call('/auth/invitation',{code:expired.code},false)).status).toBe(403);
  expect((await call('/auth/register',{login:'expired_member',password:'test-only-password-123',invite:expired.code},false)).status).toBe(403);
  expect((await createHttpHandler(runtime,origin,'',false)(new Request(origin+'/'))).status).toBe(404);
},20000);
test.skipIf(!enabled)('batch import keeps and corrects mentioned links before admitting sites',async()=>{
  const bytes=Buffer.from('domain,about,mentionedUrl,mentionedDescription\nbatch-links.example,Documentation,http://127.0.0.1/,A helpful guide');
  const command=async(method:string,params:unknown)=>call('/api/batches/commands',{method,params});
  const resource=await (await command('resource.begin',{name:'links.csv',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})).json();
  expect((await command('resource.chunk',{id:resource.id,index:0,base64:bytes.toString('base64')})).status).toBe(200);
  const summary=await (await command('import.prepare',{id:resource.id})).json();expect(summary.invalidCount).toBe(1);
  const updated=await command('import.update',{id:summary.id,revision:summary.revision,rowNumber:2,mentionedUrl:'https://www.example.com/guide',mentionedDescription:'Useful documentation and practical examples.'});expect(updated.status).toBe(200);
  const corrected=await updated.json();expect(corrected.invalidCount).toBe(0);
  const committed=await command('import.commit',{id:summary.id,revision:corrected.revision,requestKey:randomUUID()});expect(committed.status).toBe(200);
  const input=(await pool.query("select input from public.sites where domain='batch-links.example'")).rows[0].input;expect(input.mentionedUrl).toBe('https://www.example.com/guide');expect(input.mentionedDescription).toContain('documentation');
},20000);

test.skipIf(!enabled)('logout is idempotent for expired sessions while origin and active CSRF remain enforced',async()=>{
  const signIn=await call('/auth/login',{login:'owner',password:'test-only-password-123'},false),user=(await signIn.json()).user;
  const sessionCookie=signIn.headers.get('set-cookie')!.split(';')[0]!;
  const logout=(originHeader=origin,csrfHeader='')=>handler(new Request(origin+'/auth/logout',{method:'POST',headers:{origin:originHeader,cookie:sessionCookie,'x-csrf-token':csrfHeader,'content-type':'application/json'},body:'{}'}));
  expect((await logout()).status).toBe(403);
  await pool.query("update factory.sessions set expires_at=now()-interval '1 second' where csrf=$1",[user.csrf]);
  expect((await logout('https://untrusted.example')).status).toBe(403);
  const response=await logout();expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect((await logout()).status).toBe(200);
});

test.skipIf(!enabled)('temporary login is opt-in, loopback-only and can be disabled',async()=>{
 const file=join(data,'test-login.json');try{
 await writeFile(file,JSON.stringify({enabled:true,userId}));
 const remote=await handler(new Request(origin+'/auth/status',{headers:{'x-forwarded-for':'127.0.0.1'}}),'198.51.100.9');expect((await remote.json()).user).toBeNull();expect(remote.headers.get('set-cookie')).toBeNull();
 const local=await handler(new Request(origin+'/auth/status'),'127.0.0.1');expect((await local.json()).user.id).toBe(userId);expect(local.headers.get('set-cookie')).toContain('HttpOnly');
 await writeFile(file,JSON.stringify({enabled:false,userId}));expect((await (await handler(new Request(origin+'/auth/status'),'127.0.0.1')).json()).user).toBeNull();
 }finally{await rm(file,{force:true});}
});
