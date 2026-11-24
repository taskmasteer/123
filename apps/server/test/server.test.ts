import {runtimeDatabaseRole} from '../src/database-role.js';
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
  if(request.mode==='generate' && request.site.domain.startsWith('editorial-pair-')){
    const revised=request.instruction.includes('Rework the actual website');
    const content=revised
      ? '<h1>Measure the tide</h1><ol><li>Find the high water mark on the pier.</li><li>Record the water depth every hour in the same place.</li></ol>'
      : '<h1>Read the night sky</h1><p>Find a bright star above the southern horizon and sketch its position relative to a fixed point.</p>';
    await tools.write('index.html','<!doctype html><html><body><main>'+content+'<section data-mentioned-link="true"><h2>Field notes</h2><p>A companion notebook provides a space for dated observations so you can compare your readings on a later visit.</p><a href="https://example.org/field">Field notebook</a></section></main></body></html>');
    return {summary:'Fixture page',inputTokens:0,outputTokens:0};
  }
  const result=await new FakeModel().run(request,tools,signal);
  if(request.mode==='generate'&&request.site.input.mentionedUrl){let html=await tools.read('index.html');html=html.replace('</main>',`<section data-mentioned-link="true"><h2>Explore the resource</h2><p>This resource contains practical documentation for building reliable websites. Visit it for further reading and examples relevant to this project.</p><a href="${request.site.input.mentionedUrl}">Read the documentation</a></section></main>`);await tools.write('index.html',html);}
  return result;
}};
beforeAll(async()=>{if(!enabled)return;const config=JSON.parse((await readFile(process.env.SITE_FACTORY_TEST_CONFIG??'.local-state/server/config.json','utf8')).replace(/^\uFEFF/,''));const connection={host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true)};admin=new Pool({...connection,database:'postgres'});await admin.query('create database '+db);pool=new Pool({...connection,database:db,max:10});await mkdir(data,{recursive:true});await migrate(pool,root);const limited=await runtimeDatabaseRole(pool);await pool.end();pool=new Pool({...connection,...limited,database:db,max:10});runtime=await createServerRuntime(pool,root,data,origin,fixtureModel);await runtime.hosting.close();runtime.hosting=await createHosting(pool,runtime.repository,runtime.store,data,{publish:async()=>{},dns:{read:async domain=>({domain,records:[]}),write:async()=>{}},propagated:async()=>true,health:async()=>{}});await pool.query("insert into factory.hosting_addresses(address,host_id) values('192.0.2.50','fixture')");runtime.repository.beforeBatchCommit=runtime.hosting.prepareBatch;runtime.repository.canAdmitBatchSite=runtime.hosting.canAdmitBatchSite;runtime.repository.onBatchSiteCreated=runtime.hosting.reserveBatchSite;await pool.query("insert into factory.hosting_addresses(address,host_id) values('192.0.2.51','fixture')");handler=createHttpHandler(runtime,origin,resolve('apps/desktop/dist-web'));},60000);
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
test.skipIf(!enabled)('concurrent generators rewrite a duplicate automatically before both sites can publish',async()=>{
  await pool.query("insert into factory.hosting_addresses(address,host_id) values('192.0.2.60','fixture'),('192.0.2.61','fixture')");
  const created=await Promise.all(['a','b'].map(async suffix=>{
    const response=await call('/api/sites',{domain:'editorial-pair-'+suffix+'.example',about:'Field observation exercises',referenceId:'corporate',mentionedUrl:'https://example.org/field',mentionedDescription:'A field notebook for recording outdoor observations.'});
    expect(response.status).toBe(200);return (await response.json()).id as string;
  }));
  const profiles=()=>pool.query("select site_id,profile->>'digest' digest from factory.originality_profiles where site_id=any($1::uuid[]) and source like 'job:%'",[created]);
  await expect.poll(async()=>(await profiles()).rowCount,{timeout:70000,interval:350}).toBe(2);
  expect(new Set((await profiles()).rows.map(row=>row.digest)).size).toBe(2);
  await expect.poll(async()=>Number((await pool.query("select count(*) n from private.jobs where site_id=any($1::uuid[]) and data->>'state'='completed'",[created])).rows[0].n),{timeout:20000}).toBe(2);
  const jobs=await pool.query("select checkpoint_id from private.jobs where site_id=any($1::uuid[])",[created]);
  const attempts=await Promise.all(jobs.rows.map(async row=>(await runtime.store.load(row.checkpoint_id)).state.repairAttempts));
  expect(attempts.sort()).toEqual([0,1]);
},100000);

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


test.skipIf(!enabled)('password change verifies the old password and revokes other sessions',async()=>{
 const extra=await runtime.auth.login('owner','test-only-password-123');
 expect((await call('/api/account/password',{currentPassword:'incorrect-value',newPassword:'new-test-password-567'})).status).toBe(401);
 expect(await runtime.auth.session(extra.token)).toBeTruthy();
 const changed=await call('/api/account/password',{currentPassword:'test-only-password-123',newPassword:'new-test-password-567'});
 expect(changed.status).toBe(200);expect(await runtime.auth.session(extra.token)).toBeNull();
 expect((await call('/api/account/sessions')).status).toBe(200);
 await expect(runtime.auth.login('owner','test-only-password-123')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 const current=await runtime.auth.login('owner','new-test-password-567');expect(await runtime.auth.session(current.token)).toBeTruthy();
 expect((await call('/api/account/sessions/revoke',{})).status).toBe(200);expect(await runtime.auth.session(current.token)).toBeNull();
},15000);

test.skipIf(!enabled)('application database role cannot create a database or read server files',async()=>{
 await expect(pool.query('create database sf_forbidden_test')).rejects.toMatchObject({code:'42501'});
 await expect(pool.query("select pg_read_file('/etc/passwd')")).rejects.toMatchObject({code:'42501'});
 const role=(await pool.query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user')).rows[0];
 expect(role).toEqual({rolsuper:false,rolcreatedb:false,rolcreaterole:false});
});

test.skipIf(!enabled)('explicitly archived domains can be reused without deleting history or admitting an active duplicate',async()=>{
 const tx=await pool.connect();
 try{
   await tx.query('begin');
   const principal={userId,role:'admin' as const},input={domain:'archived-pilot.example'};
   const first=await runtime.repository.insertSiteInTransaction(tx,input,principal);
   await tx.query('update public.sites set archived_at=now() where id=$1',[first.id]);
   expect(await runtime.repository.get(first.id,tx)).toBeNull();
   const next=await runtime.repository.insertSiteInTransaction(tx,input,principal);
   expect(next.id).not.toEqual(first.id);
   expect((await tx.query('select 1 from private.jobs where site_id=$1',[first.id])).rowCount).toBe(1);
   await expect(runtime.repository.insertSiteInTransaction(tx,input,principal)).rejects.toMatchObject({code:'DUPLICATE_DOMAIN'});
 }finally{await tx.query('rollback');tx.release();}
});
