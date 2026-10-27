import {test,expect} from 'vitest';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createAuth} from '../../apps/control/src/auth.js';
import {database,identities,seedUsers} from './database.js';
import {createApp} from '../../apps/control/src/app.js';
import {SupabaseRepository} from '../../packages/adapters/src/supabase-repository.js';
import {randomUUID} from 'node:crypto';
import {bootstrapAdmin} from '../../apps/control/src/routes/admin.js';
import {configuredInvitations} from '../../apps/control/src/invitations.js';
test('cryptographic identity ignores metadata and resolves fresh membership',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwk=await exportJWK(publicKey); jwk.kid='fixture';
 let role:'spec-user'|'user'='spec-user';
 const auth=createAuth({issuer:'https://auth.example/auth/v1',audience:'authenticated',jwks:createLocalJWKSet({keys:[jwk]}),membership:async()=>role,worker:async()=>null});
 const token=await new SignJWT({user_metadata:{role:'admin'}}).setIssuedAt().setSubject('11111111-1111-4111-8111-111111111111').setIssuer('https://auth.example/auth/v1').setAudience('authenticated').setExpirationTime('5m').setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(privateKey);
 expect(await auth.verifyUser(token)).toEqual({userId:'11111111-1111-4111-8111-111111111111',role:'spec-user'});
 role='user'; expect((await auth.verifyUser(token)).role).toBe('user');
 await expect(auth.verifyUser(token+'x')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 await expect(auth.verifyWorker('revoked')).rejects.toMatchObject({code:'UNAUTHENTICATED'});
});
test('admin invitations reconcile provider success and catalogue/assignments stay admin-only',async()=>{
 const pool=await database();try{await seedUsers(pool);const repo=new SupabaseRepository(pool),invited=randomUUID();let attempts=0,failRead=true;
 const invitations=configuredInvitations(repo,{SUPABASE_URL:'https://auth.example',SUPABASE_SERVICE_ROLE_KEY:'fixture'},async(input,init)=>{
  expect((await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='idle in transaction'")).rows[0].n).toBe(0);
  const user={id:invited,email:'invite@example.test',aud:'authenticated'};
  if(init!.method==='POST'){attempts++;await pool.query('insert into auth.users values($1)',[invited]);return Response.json(user);}
  if(String(input).includes('?'))return Response.json({users:[]});
  if(failRead){failRead=false;throw new Error('read after acknowledged invite failed');}return Response.json(user);
 });
 const app=createApp({repository:repo,auth:{verifyUser:async id=>({userId:id,role:(await repo.membership(id))!}),verifyWorker:async()=>{throw new Error('unused');}},invitations:invitations!});
 const request=(actor:string,path:string,method='GET',body?:unknown)=>app(new Request('https://control.test'+path,{method,headers:{authorization:'Bearer '+actor,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 const body={email:'invite@example.test',role:'spec-user'};expect((await request(identities.user,'/admin/invitations','POST',body)).status).toBe(403);expect((await request(identities.admin,'/admin/invitations','POST',body)).status).toBe(503);expect(await repo.membership(invited)).toBeNull();const operation=(await pool.query('select id from private.invitations')).rows[0].id;expect((await request(identities.admin,'/admin/invitations','POST',body)).status).toBe(200);expect((await pool.query('select operation_id from private.invitation_attempts')).rows[0].operation_id).toBe(operation);expect(await repo.membership(invited)).toBe('spec-user');expect((await request(identities.admin,'/admin/invitations','POST',body)).status).toBe(200);expect(attempts).toBe(1);
 await pool.query("insert into private.catalog values('style','fixture',$1)",[{id:'fixture',name:'Fixture',version:'1.0.0',enabled:true,referenceIds:[]}]);expect((await request(identities.spec,'/catalog/styles/fixture','PATCH',{enabled:false})).status).toBe(403);expect((await request(identities.admin,'/catalog/styles/fixture','PATCH',{enabled:false})).status).toBe(200);expect((await (await request(identities.user,'/catalog')).json()).styles[0].enabled).toBe(false);
 const site=await repo.create({domain:'assigned.example'},{userId:identities.user,role:'user'});expect((await request(identities.spec,`/admin/sites/${site.id}/assignments`,'PUT',{userIds:[identities.spec]})).status).toBe(403);expect((await request(identities.admin,`/admin/sites/${site.id}/assignments`,'PUT',{userIds:[identities.spec]})).status).toBe(200);expect((await request(identities.spec,'/sites/'+site.id)).status).toBe(200);
 await expect(bootstrapAdmin(repo,invited,async()=>({id:identities.user,email:'wrong@example.test'}))).rejects.toMatchObject({code:'FORBIDDEN'});await expect(bootstrapAdmin(repo,invited,async()=>({id:invited,email:'invite@example.test'}))).rejects.toMatchObject({code:'CONFLICT'});
 }finally{await pool.end();}
});
test.skip('managed Supabase Auth/sign-in/refresh/invitation/PostgREST acceptance requires an authorized test project and credentials',()=>{});
test('managed registry cursor exposes all51 authorized rows without foreign rows or duplicate pages',async()=>{
 const pool=await database();try{
  await seedUsers(pool);const repo=new SupabaseRepository(pool);
  await pool.query("insert into public.sites(id,domain,owner_id,input) select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'registry-'||n||'.example',$1,jsonb_build_object('domain','registry-'||n||'.example') from generate_series(1,51) n",[identities.user]);
  await repo.create({domain:'foreign-page.example'},{userId:identities.spec,role:'spec-user'});
  const app=createApp({repository:repo,auth:{verifyUser:async()=>({userId:identities.user,role:'user'}),verifyWorker:async()=>{throw Error('unused');}}});
  const get=async(path:string)=>app(new Request('https://control.test'+path,{headers:{authorization:'Bearer fixture'}}));
  const first=await (await get('/sites')).json();expect(first.items).toHaveLength(50);expect(first.nextCursor).toBe(first.items[49].id);
  const second=await (await get('/sites?cursor='+first.nextCursor)).json();expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
  const rows=[...first.items,...second.items];expect(new Set(rows.map(row=>row.id)).size).toBe(51);expect(rows.every(row=>row.ownerId===identities.user)).toBe(true);expect(second.items[0].domain).toBe('registry-51.example');
 }finally{await pool.end();}
});
test('HTTP role matrix, safe DTOs, concurrent admission, fresh demotion and worker revocation',async()=>{
 const pool=await database();try {await seedUsers(pool);const repo=new SupabaseRepository(pool);
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='matrix';
 const auth=createAuth({issuer:'https://auth.test',audience:'authenticated',jwks:createLocalJWKSet({keys:[jwk]}),membership:id=>repo.membership(id),worker:h=>repo.worker(h)});
 const token=async(id:string,expires='5m',issuer='https://auth.test',audience='authenticated')=>new SignJWT({user_metadata:{role:'admin'},role:'service_role'}).setIssuedAt().setSubject(id).setIssuer(issuer).setAudience(audience).setExpirationTime(expires).setProtectedHeader({alg:'RS256',kid:'matrix'}).sign(privateKey);
 const tokens={user:await token(identities.user),spec:await token(identities.spec),admin:await token(identities.admin)};
 const app=createApp({auth,repository:repo}),other=createApp({auth,repository:new SupabaseRepository(pool)});
 const request=(role:keyof typeof tokens,path:string,method='GET',body?:unknown,handler=app)=>handler(new Request('https://control.test'+path,{method,headers:{authorization:'Bearer '+tokens[role],'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 for(const bad of [await token(identities.user,'-1s'),await token(identities.user,'5m','https://wrong.test'),await token(identities.user,'5m','https://auth.test','other')])await expect(auth.verifyUser(bad)).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 expect((await request('user','/sites','POST',{domain:'spoof.test',ownerId:identities.admin})).status).toBe(400);
 const created=await request('spec','/sites','POST',{domain:'Owned.Example'});expect(created.status).toBe(200);const site=await created.json();expect(site.ownerId).toBe(identities.spec);
 expect((await request('user','/sites/'+site.id)).status).toBe(404);
 expect((await request('admin','/sites/'+site.id)).status).toBe(200);
 const foreign=await repo.create({domain:'user.example'},{userId:identities.user,role:'user'});
 expect((await request('user',`/sites/${foreign.id}/edits`,'POST',{instruction:'edit',expectedRevision:0})).status).toBe(403);
 expect((await request('spec',`/sites/${foreign.id}/edits`,'POST',{instruction:'edit',expectedRevision:0})).status).toBe(404);
 for(const path of ['/admin/users','/admin/integrations','/workers'])expect((await request('user',path)).status).toBe(403);
 expect((await request('spec',`/sites/${site.id}/export`,'POST',{})).status).toBe(403);
 expect((await request('admin',`/sites/${site.id}/publish`,'POST',{})).status).toBe(503);
 await pool.query("update private.jobs set data=jsonb_set(data,'{providerRecovery}','{\"secret\":\"PRIVATE_TICKET\"}'),worker_id=null where id=$1",[site.id]);
 expect(JSON.stringify(await (await request('spec','/sites')).json())).not.toContain('PRIVATE_TICKET');
 const rev=randomUUID(),manifest=randomUUID();await pool.query('insert into private.artifacts values($1,$2,$3,true)',[manifest,site.id,{}]);await pool.query("insert into revisions values($1,$2,null,$3,'published',1)",[rev,site.id,manifest]);await pool.query('update sites set published_id=$2 where id=$1',[site.id,rev]);await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1",[site.id]);
 const requests=await Promise.all([request('spec',`/sites/${site.id}/edits`,'POST',{instruction:'Keep private job data',expectedRevision:0}),request('spec',`/sites/${site.id}/edits`,'POST',{instruction:'Race',expectedRevision:0},other)]);
 expect(requests.map(r=>r.status).sort()).toEqual([200,409]);
 const state=await repo.editingState(site.id);expect(state.candidates).toHaveLength(1);expect((await pool.query('select kind,operation_id from private.site_operations where site_id=$1',[site.id])).rows[0]).toEqual({kind:'job',operation_id:state.candidates[0]!.jobId});
 const list=await (await request('spec',`/sites/${site.id}/candidates`)).json();expect(list.candidates[0].job.edit).toBeUndefined();expect(list.candidates[0].instruction).toBe('Keep private job data');
 await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"needs_attention\"') where id=$1",[state.candidates[0]!.jobId]);
 expect((await request('spec',`/sites/${site.id}/candidates/${state.candidates[0]!.id}/reject`,'POST',{})).status).toBe(200);
 const admission=await repo.acquire({userId:identities.spec,role:'spec-user'},site.id);await pool.query("update private.site_operations set expires_at=clock_timestamp()-interval '1 second' where site_id=$1",[site.id]);await expect(repo.compareAndSet(site.id,0,{domainStatus:'changed'},admission)).rejects.toMatchObject({code:'STALE_LEASE'});await repo.release(admission);
 const enrolled=await (await request('admin','/workers/enroll','POST',{name:'test worker'})).json();expect((await auth.verifyWorker(enrolled.token)).workerId).toBe(enrolled.workerId);expect((await pool.query('select token_hash from private.workers where id=$1',[enrolled.workerId])).rows[0].token_hash).not.toBe(enrolled.token);
 expect((await app(new Request('https://control.test/uploads/prepare',{method:'POST',headers:{authorization:'Bearer '+enrolled.token,'content-type':'application/json'},body:'{}'}))).status).toBe(503);
 await request('admin',`/workers/${enrolled.workerId}/revoke`,'POST',{});await expect(auth.verifyWorker(enrolled.token)).rejects.toMatchObject({code:'UNAUTHENTICATED'});
 await request('admin',`/admin/users/${identities.spec}`,'PATCH',{role:'user',active:true});expect((await (await request('spec','/session')).json()).principal.role).toBe('user');expect((await request('spec',`/sites/${site.id}/edits`,'POST',{instruction:'forged admin',expectedRevision:0})).status).toBe(403);
 }finally{await pool.end();}
});
test('actual PostgreSQL nonowner RLS isolates sites and denies direct privilege escalation',async()=>{
 const pool=await database(); try {
 await seedUsers(pool);
 const own='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',foreign='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 await pool.query('insert into sites(id,domain,owner_id,input) values($1,$2,$3,$4),($5,$6,$7,$4)',[own,'own.example',identities.spec,{},foreign,'foreign.example',identities.user]);
 const client=await pool.connect();try {
 await client.query('set role authenticated');await client.query("select set_config('request.jwt.claim.sub',$1,false)",[identities.spec]);
 expect((await client.query('select id from sites')).rows).toEqual([{id:own}]);
 for(const sql of ['update memberships set role=\'admin\'','insert into assignments values(\''+foreign+'\',\''+identities.spec+'\')','select * from private.workers','select * from private.checkpoints','update sites set revision=999','select manifest_id from revisions'])await expect(client.query(sql)).rejects.toMatchObject({code:'42501'});
 await pool.query('insert into assignments values($1,$2)',[foreign,identities.spec]);expect((await client.query('select id from sites')).rows).toHaveLength(2);
 await pool.query('update memberships set active=false where user_id=$1',[identities.spec]);expect((await client.query('select id from sites')).rows).toHaveLength(0);
 expect((await client.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
 }finally{client.release();}
 }finally{await pool.end();}
});
