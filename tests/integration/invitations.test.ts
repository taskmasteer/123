import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {database,identities,seedUsers} from './database.js';
import {SupabaseRepository} from '../../packages/adapters/src/supabase-repository.js';
import {configuredInvitations} from '../../apps/control/src/invitations.js';
import {createApp} from '../../apps/control/src/app.js';
const env={SUPABASE_URL:'https://auth.example',SUPABASE_SERVICE_ROLE_KEY:'fixture-not-a-real-key'};
function app(repo:SupabaseRepository,transport:typeof fetch){return createApp({repository:repo,invitations:configuredInvitations(repo,env,transport)!,auth:{verifyUser:async()=>({userId:identities.admin,role:'admin'}),verifyWorker:async()=>{throw Error('unused');}}});}
function invite(handler:ReturnType<typeof createApp>,email='new@example.test'){return handler(new Request('https://control.example/admin/invitations',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({email,role:'spec-user'})}));}
test('unknown invite never resends or grants unconfirmed/spoofed identity; explicit retry recovers confirmed exact email',async()=>{
 const pool=await database();try{
  await seedUsers(pool);const repo=new SupabaseRepository(pool),id=randomUUID();let sent=0,confirmed=false,wrong=false;
  const user=()=>({id,email:'new@example.test',aud:'authenticated',invited_at:'2026-10-27T00:00:00Z',...(confirmed?{email_confirmed_at:'2026-10-27T00:01:00Z'}:{}),user_metadata:{email_confirmed_at:'2026-10-27T00:01:00Z',role:'admin'}});
  const handler=app(repo,async(input,init)=>{expect((await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='idle in transaction'")).rows[0].n).toBe(0);if(init!.method==='POST'){sent++;await pool.query('insert into auth.users values($1)',[id]);throw Error('response lost');}return Response.json(String(input).includes('?')?{users:sent?[user()]:[]}:{...user(),...(wrong?{email:'foreign@example.test'}:{})});});
  for(let i=0;i<2;i++){expect((await invite(handler)).status).toBe(503);expect(await repo.membership(id)).toBeNull();}
  confirmed=true;wrong=true;expect((await invite(handler)).status).toBe(503);expect(await repo.membership(id)).toBeNull();
  wrong=false;expect((await invite(handler)).status).toBe(200);expect(await repo.membership(id)).toBe('spec-user');expect(sent).toBe(1);
  const row=(await pool.query('select a.evidence,i.state from private.invitation_attempts a join private.invitations i on i.id=a.operation_id')).rows[0];expect(row).toEqual({evidence:'existing',state:'completed'});
  const client=await pool.connect();try{await client.query('set role authenticated');await expect(client.query('select * from private.invitation_attempts')).rejects.toMatchObject({code:'42501'});}finally{await client.query('reset role');client.release();}
 }finally{await pool.end();}
});
test('independent API instances serialize invitation sends in PostgreSQL',async()=>{
 const pool=await database();try{
  await seedUsers(pool);const id=randomUUID(),user={id,email:'new@example.test',aud:'authenticated'};let posts=0;
  let release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
  const transport:typeof fetch=async(input,init)=>{if(init!.method==='POST'){posts++;started();await held;await pool.query('insert into auth.users values($1)',[id]);return Response.json(user);}return Response.json(String(input).includes('?')?{users:[]}:user);};
  const a=app(new SupabaseRepository(pool),transport),b=app(new SupabaseRepository(pool),transport),first=invite(a);
  await entered;try{expect((await invite(b)).status).toBe(503);expect(posts).toBe(1);}finally{release();}
  expect((await first).status).toBe(200);expect((await invite(b)).status).toBe(200);expect(posts).toBe(1);
 }finally{await pool.end();}
});
test('fresh admin revocation after provider success prevents binding and membership; restoration can reconcile',async()=>{
 const pool=await database();try{
  await seedUsers(pool);const repo=new SupabaseRepository(pool),id=randomUUID();let sent=0;
  const user={id,email:'new@example.test',aud:'authenticated',email_confirmed_at:'2026-10-27T00:00:00Z'};
  const handler=app(repo,async(input,init)=>{if(init!.method==='POST'){sent++;await pool.query('insert into auth.users values($1)',[id]);await pool.query('update memberships set active=false where user_id=$1',[identities.admin]);return Response.json(user);}return Response.json(String(input).includes('?')?{users:sent?[user]:[]}:user);});
  expect((await invite(handler)).status).toBe(403);expect(await repo.membership(id)).toBeNull();expect((await pool.query('select user_id from private.invitation_attempts')).rows[0].user_id).toBeNull();
  expect((await invite(handler)).status).toBe(403);await pool.query('update memberships set active=true where user_id=$1',[identities.admin]);expect((await invite(handler)).status).toBe(200);expect(sent).toBe(1);
 }finally{await pool.end();}
});
