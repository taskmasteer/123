// Explicit live acceptance: one allowed pilot domain, exact DNS snapshot restoration.
// No generated user sites are created; all local rows live in an isolated database.
import {Pool} from 'pg';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {migrate} from '../dist/apps/server/src/migrate.js';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {createHosting,propagated,verifyHostedRelease} from '../dist/apps/server/src/hosting.js';
import {linuxPublish} from '../dist/apps/server/src/linux-publisher.js';
import {NamecheapDns,zoneHash,mergeIPv4} from '../dist/apps/server/src/namecheap.js';
import {SupabaseRepository,configureSnapshotConnection} from '../dist/packages/adapters/src/supabase-repository.js';
import {R2Store} from '../dist/packages/adapters/src/r2-store.js';
import {PostgresQueue} from '../dist/packages/adapters/src/postgres-queue.js';
import {FileObjectTransport} from '../dist/apps/server/src/file-store.js';

const domain='chinazes.space',ip='51.83.126.15',id='sf_live_hosting_'+randomUUID().replaceAll('-',''),root=resolve('.');
const evidence=resolve('.local-state/server/hosting-live',id);await mkdir(evidence,{recursive:true});
const config=JSON.parse(await readFile('.local-state/server/config.json','utf8'));
const connection={host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true)};
const admin=new Pool({...connection,database:'postgres'}),production=new Pool({...connection,database:'factory'});
const guard=await production.connect();await guard.query('select pg_advisory_lock(78424521)');
let pool,hosting,dns,before,after,site,result={passed:false,domain,ip};
try{
  assert.equal((await production.query('select site_id from factory.hosting_addresses where address=$1',[ip])).rows[0]?.site_id,null,'Live test address must be free');
  const secret=(await production.query("select value from factory.settings where key='namecheap'")).rows[0];
  dns=new NamecheapDns(JSON.parse(await protectSecret(secret.value,true)));
  before=await dns.read(domain);after=mergeIPv4(before,ip);await writeFile(join(evidence,'dns-before.json'),JSON.stringify(before,null,2));await writeFile(join(evidence,'dns-after.json'),JSON.stringify(after,null,2));
  await admin.query('create database '+id);pool=new Pool({...connection,database:id,max:10});await migrate(pool,root);
  const actor={userId:randomUUID(),role:'admin'};await pool.query('insert into auth.users values($1)',[actor.userId]);await pool.query('insert into public.users(id) values($1)',[actor.userId]);await pool.query("insert into public.memberships values($1,'admin',true)",[actor.userId]);
  const repository=new SupabaseRepository(configureSnapshotConnection(pool,'direct')),store=new R2Store(repository,new FileObjectTransport(join(evidence,'objects')),new PostgresQueue(repository));
  await pool.query('insert into factory.hosting_addresses(address,host_id) values($1,$2)',[ip,'ovh-pilot']);site=await repository.create({domain},actor);
  await writeFile(join(evidence,'remote-test.json'),JSON.stringify({siteId:site.id,domain,ip}));
  const hostFile=resolve('.local-state/server/ssh/ovh-pilot.json');
  hosting=await createHosting(pool,repository,store,evidence,{publish:(target,files)=>linuxPublish(hostFile,target,files),dns,propagated,health:verifyHostedRelease});
  async function version(label){const revision=randomUUID(),html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Site Factory deployment check</title><body style="background:#000;color:#fff;font-family:Arial;padding:10vw"><h1>Deployment verification</h1><p>Temporary technical check. ${label}</p></body></html>`;const manifest=await store.put(site.id,[{path:'index.html',bytes:Buffer.from(html),mediaType:'text/html'}],'hosting-check');await pool.query("insert into public.revisions values($1,$2,null,$3,'draft',$4)",[revision,site.id,manifest.id,Date.now()]);await pool.query('update public.sites set draft_id=$2 where id=$1',[site.id,revision]);return revision;}
  async function wait(){let last='';const deadline=Date.now()+20*60000;while(Date.now()<deadline){const state=(await hosting.details(site.id)).jobs[0];const status=state.status+':'+state.phase;if(status!==last){console.log(status);last=status;}if(state.status==='failed')throw Error(state.error);if(state.status==='complete')return;await new Promise(r=>setTimeout(r,3000));}throw Error('Live publication deadline exceeded');}
  const first=await version('Release 1');await hosting.enqueue(actor,site.id,{});await wait();
  const second=await version('Release 2');await hosting.enqueue(actor,site.id,{});await wait();
  assert.equal((await hosting.details(site.id)).binding.address,ip);
  await hosting.enqueue(actor,site.id,{action:'rollback',revisionId:first});await wait();
  await verifyHostedRelease(domain,ip,first,true);
  const response=await fetch('https://'+domain+'/',{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);assert.match(await response.text(),/Release 1/);
  result={...result,passed:true,siteId:site.id,first,second,checks:['SSH upload','unique IPv4','Namecheap read-merge-write','DNS propagation','trusted HTTPS','update same IPv4','rollback same IPv4','public domain fetch']};
}catch(error){result.error=error.message;process.exitCode=1;console.error(error.message);}
finally{
  await hosting?.close();
  if(dns&&before&&after){try{const current=await dns.read(domain);if(zoneHash(current)===zoneHash(after)){await dns.write(before);assert.equal(zoneHash(await dns.read(domain)),zoneHash(before));result.dnsRestored=true;}else if(zoneHash(current)===zoneHash(before)){result.dnsRestored=true;}else{result.dnsRestored=false;throw Error('DNS changed externally; restoration stopped');}}catch(error){result.restorationError=error.message;process.exitCode=1;}}
  if(pool){result.jobs=(await pool.query('select id,revision_id,status,phase,error from factory.hosting_jobs order by id')).rows;await pool.end();await admin.query('drop database '+id);}
  result.finishedAt=new Date().toISOString();await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));
  await guard.query('select pg_advisory_unlock(78424521)');guard.release();await production.end();await admin.end();
  console.log(JSON.stringify({evidence,passed:result.passed,dnsRestored:result.dnsRestored,siteId:site?.id}));
}
