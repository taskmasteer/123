import {linuxSecretCodec} from '../src/linux-secrets.js';
import {randomBytes} from 'node:crypto';
import {beforeAll,afterAll,test,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {migrate} from '../src/migrate.js';
import {protectSecret} from '../src/secrets.js';
import {createHosting,type HostingPorts} from '../src/hosting.js';
import {createMonitoring} from '../src/monitoring.js';
import {createServers} from '../src/servers.js';
import {captureWindowsBackup,restoreWindowsBackup,removePrivateTree} from '../src/recovery.js';
import {createServerRuntime} from '../src/runtime.js';
import {MaintenanceGate} from '../src/maintenance-gate.js';
import {SupabaseRepository,configureSnapshotConnection} from '../../../packages/adapters/src/supabase-repository.js';
import {R2Store} from '../../../packages/adapters/src/r2-store.js';
import {FileObjectTransport} from '../src/file-store.js';
import {PostgresQueue} from '../../../packages/adapters/src/postgres-queue.js';
import {LocalAuth} from '../src/auth.js';
import type {DnsZone} from '../src/namecheap.js';
const enabled=process.env.SITE_FACTORY_SERVER_TEST==='1',root=resolve('.'),id='sf_ops_'+randomUUID().replaceAll('-',''),data=resolve('.local-state',id);
const actor={userId:randomUUID(),role:'admin' as const};let admin:Pool,pool:Pool,repository:SupabaseRepository,store:R2Store,connection:any;
beforeAll(async()=>{if(!enabled)return;const c=JSON.parse(await readFile(process.env.SITE_FACTORY_TEST_CONFIG??'.local-state/server/config.json','utf8'));connection={host:'127.0.0.1',port:c.databasePort,user:'factory',password:await protectSecret(c.databasePassword,true)};admin=new Pool({...connection,database:'postgres'});await admin.query('create database '+id);pool=new Pool({...connection,database:id,max:10});await mkdir(data,{recursive:true});await migrate(pool,root);await pool.query('insert into auth.users values($1)',[actor.userId]);await pool.query('insert into public.users(id) values($1)',[actor.userId]);await pool.query("insert into public.memberships values($1,'admin',true)",[actor.userId]);repository=new SupabaseRepository(configureSnapshotConnection(pool,'direct'));store=new R2Store(repository,new FileObjectTransport(join(data,'objects')),new PostgresQueue(repository));
 for(const [name,ip]of [['a','203.0.113.10'],['b','203.0.113.20'],['ops','203.0.113.30']]){await pool.query("insert into factory.hosting_hosts(id,name,host,port,username,host_fingerprint,credential,config,status,phase) values($1,$1,$2,22,'ubuntu',$3,$4,$5,'ready','ready')",[name,ip,'SHA256:'+'a'.repeat(43),await protectSecret('fixture-private-key'),{additionalIPv4:[],publicKey:'ssh-ed25519 AAAA fixture'}]);await pool.query('insert into factory.hosting_addresses(address,host_id) values($1,$2)',[ip,name]);}
},60000);
afterAll(async()=>{if(!enabled)return;await pool?.end();if(admin){await admin.query('drop database '+id+' with (force)');await admin.end();}},30000);
async function version(siteId:string,text:string){const revision=randomUUID(),manifest=await store.put(siteId,[{path:'index.html',bytes:Buffer.from('<h1>'+text+'</h1>'),mediaType:'text/html'}],'fixture');await pool.query("insert into public.revisions values($1,$2,null,$3,'draft',$4)",[revision,siteId,manifest.id,Date.now()]);await pool.query('update public.sites set draft_id=$2 where id=$1',[siteId,revision]);return revision;}
test('maintenance drains admitted requests and rejects new mutations until completion',async()=>{
 const gate=new MaintenanceGate();let release!:()=>void,started=false;
 const request=gate.request(()=>new Promise<void>(r=>{release=r;}));const backup=gate.exclusive(async()=>{started=true;});expect(started).toBe(false);await expect(gate.request(async()=>{})).rejects.toThrow(/копирование/);release();await request;await backup;expect(started).toBe(true);expect(gate.busy).toBe(false);
});
test.skipIf(!enabled)('migration preserves the old binding until HTTPS; address release waits for cache, DNS and Linux cleanup',async()=>{
 const site=await repository.create({domain:'migration.example'},actor),v1=await version(site.id,'one');let ready=true;let zone:DnsZone={domain:site.domain,records:[]};const files=new Map<string,string>(),maintained:string[]=[];
 const ports:HostingPorts={publish:async(t,f)=>{if(f)for(const ip of t.ips)files.set(ip,t.revisionId);},dns:{read:async()=>structuredClone(zone),write:async z=>{zone=structuredClone(z);}},propagated:async()=>ready,health:async(_d,ip,rev)=>{expect(files.get(ip)).toBe(rev);},maintain:async(_h,t,action)=>{maintained.push(action);if(action==='remove')files.delete('203.0.113.10');}};
 let hosting=await createHosting(pool,repository,store,data,ports);
 try{
  await hosting.enqueue(actor,site.id,{serverId:'a'});await hosting.tick();expect((await hosting.details(site.id)).binding.revision_id).toBe(v1);
  const v2=await version(site.id,'two');zone.records.find(r=>r.Type==='A')!.TTL='604800';ready=false;await hosting.enqueue(actor,site.id,{action:'migrate',serverId:'b'});await hosting.tick();expect((await hosting.details(site.id)).binding).toMatchObject({address:'203.0.113.10',revision_id:v1});expect(files.get('203.0.113.20')).toBe(v2);
  await hosting.close();hosting=await createHosting(pool,repository,store,data,ports);ready=true;await pool.query('update factory.hosting_jobs set next_attempt=now()');await hosting.tick();expect((await hosting.details(site.id)).binding).toMatchObject({address:'203.0.113.20',revision_id:v2});
  expect(new Date((await hosting.details(site.id)).addresses.find(a=>a.address==='203.0.113.10').release_after).getTime()).toBeGreaterThan(Date.now()+604795000);
  await expect(hosting.enqueue(actor,site.id,{action:'release',address:'203.0.113.10'})).rejects.toThrow(/DNS-кэша/);
  await pool.query("update factory.hosting_addresses set release_after=now()-interval '1 second' where address='203.0.113.10'");
  zone.records.push({Name:'www',Type:'A',Address:'203.0.113.10',TTL:'300',MXPref:'10'});await hosting.enqueue(actor,site.id,{action:'release',address:'203.0.113.10'});await hosting.tick();expect((await hosting.details(site.id)).jobs[0].status).toBe('failed');expect(maintained).toEqual([]);
  zone.records=zone.records.filter(r=>r.Name!=='www');await hosting.retry(actor,site.id);await hosting.tick();expect(maintained).toEqual(['remove']);expect((await pool.query("select state,site_id from factory.hosting_addresses where address='203.0.113.10'")).rows[0]).toEqual({state:'free',site_id:null});
  await expect(hosting.enqueue(actor,site.id,{action:'release',address:'203.0.113.20'})).rejects.toThrow(/Текущий/);
 }finally{await hosting.close();}
},60000);
test.skipIf(!enabled)('monitoring detects DNS, revision and certificate failures, and discards stale deployment results',async()=>{
 const site=(await pool.query("select id from public.sites where domain='migration.example'")).rows[0];let dns=true,http=true,expiry=Date.now()+90*86400000,change=false;
 const monitor=await createMonitoring(pool,{dns:async()=>dns,health:async()=>{if(!http)throw Error('offline');},certificate:async()=>{if(change)await pool.query("update factory.hosting_sites set address='203.0.113.10' where site_id=$1",[site.id]);return expiry;}});
 try{await monitor.check(site.id);expect((await pool.query('select status from factory.hosting_health where site_id=$1',[site.id])).rows[0].status).toBe('healthy');dns=false;await monitor.check(site.id);expect((await pool.query('select checks,status from factory.hosting_health where site_id=$1',[site.id])).rows[0]).toMatchObject({status:'failed',checks:{dns:false,http:true}});dns=true;expiry=Date.now()+7*86400000;await monitor.check(site.id);expect((await pool.query('select status from factory.hosting_health where site_id=$1',[site.id])).rows[0].status).toBe('warning');http=false;await monitor.check(site.id);expect((await pool.query('select status from factory.hosting_health where site_id=$1',[site.id])).rows[0].status).toBe('failed');
  await pool.query('delete from factory.hosting_health where site_id=$1',[site.id]);http=true;change=true;await monitor.check(site.id);expect((await pool.query('select 1 from factory.hosting_health where site_id=$1',[site.id])).rowCount).toBe(0);await pool.query("update factory.hosting_sites set address='203.0.113.20' where site_id=$1",[site.id]);
 }finally{await monitor.close();}
},30000);
test.skipIf(!enabled)('server maintenance adds addresses, rotates keys with restart recovery, checks connection before commit and drains safely',async()=>{
 const actions:string[]=[];let failRemoval=true,failConnection=true;
 const ports={fingerprint:async()=>{throw Error('must preserve pin');},execute:async(host:any,command:string,input:string)=>{
  if(command.includes('$SSH_CONNECTION')){if(host.port===2222&&failConnection){failConnection=false;throw Error('new connection unavailable');}return '203.0.113.1 40000 '+host.host+' 22';}
  if(input){const p=JSON.parse(input);actions.push(p.action);if(p.action==='remove'&&failRemoval){failRemoval=false;throw Error('disconnect after committing new key');}return JSON.stringify({ok:true,rollback:p.action==='network'?'network-unit':null,ready:true});}return '';
 }};
 let servers=await createServers(pool,root,data,ports);
 try{
  await servers.maintain('ops',{action:'addresses',addresses:'203.0.113.31'});expect((await pool.query("select state from factory.hosting_addresses where address='203.0.113.31'")).rows[0].state).toBe('provisioning');await servers.tick();expect((await servers.list()).find(h=>h.id==='ops').status).toBe('ready');expect(actions).toContain('confirm-network');
  await expect(servers.maintain('ops',{action:'addresses',addresses:'203.0.113.20'})).rejects.toThrow(/уже/);
  const before=(await pool.query("select credential from factory.hosting_hosts where id='ops'")).rows[0].credential;
  await servers.maintain('ops',{action:'rotate'});await servers.tick();const interrupted=(await pool.query("select credential,operation,status from factory.hosting_hosts where id='ops'")).rows[0];expect(interrupted.status).toBe('failed');expect(interrupted.credential).not.toBe(before);expect(interrupted.operation.step).toBe('remove');
  await servers.close();servers=await createServers(pool,root,data,ports);await servers.retry('ops');await servers.tick();expect((await servers.list()).find(h=>h.id==='ops').status).toBe('ready');expect(actions.filter(a=>a==='install')).toHaveLength(1);
  await servers.maintain('ops',{action:'connection',name:'Updated',host:'203.0.113.30',port:2222,username:'ubuntu'});await servers.tick();expect((await pool.query("select port from factory.hosting_hosts where id='ops'")).rows[0].port).toBe(22);await servers.retry('ops');await servers.tick();expect((await servers.list()).find(h=>h.id==='ops')).toMatchObject({port:2222,name:'Updated',status:'ready'});
  await servers.maintain('ops',{action:'drain'});expect((await servers.list()).find(h=>h.id==='ops').status).toBe('draining');const site=await repository.create({domain:'reserved.example'},actor);await pool.query("update factory.hosting_addresses set site_id=$1,state='reserved' where address='203.0.113.31'",[site.id]);await expect(servers.maintain('ops',{action:'retire'})).rejects.toThrow(/освободите/);await pool.query("update factory.hosting_addresses set site_id=null,state='free' where address='203.0.113.31'");await servers.maintain('ops',{action:'retire'});expect((await servers.list()).find(h=>h.id==='ops').status).toBe('retired');await servers.maintain('ops',{action:'activate'});await servers.tick();expect((await servers.list()).find(h=>h.id==='ops').status).toBe('ready');
 }finally{await servers.close();}
},60000);
test.skipIf(!enabled)('retention keeps five published revisions, preserves pins on remote failure and blocks rollback to pruned history',async()=>{
 const site=await repository.create({domain:'retention.example'},actor),versions:string[]=[];let fail=true;const kept:string[][]=[];
 const ports:HostingPorts={publish:async()=>{},dns:{read:async()=>({domain:site.domain,records:[]}),write:async()=>{}},propagated:async()=>true,health:async()=>{},maintain:async(_h,_t,_a,keep)=>{kept.push(keep!);if(fail)throw Error('remote unavailable');}};
 const hosting=await createHosting(pool,repository,store,data,ports);
 try{
  for(let i=0;i<7;i++){const rev=await version(site.id,'version '+i);versions.push(rev);await pool.query("insert into factory.hosting_jobs(site_id,revision_id,address,action,actor,status,phase) values($1,$2,'203.0.113.10','deploy',$3,'complete','ready')",[site.id,rev,actor.userId]);const row=await repository.revision(rev);await pool.query("insert into private.payload_pins(id,kind,payload_id,expires_at) values($1,'artifact',$2,'infinity')",[rev,row!.manifestId]);}
  await pool.query("update factory.hosting_addresses set site_id=$1,state='active' where address='203.0.113.10'",[site.id]);await pool.query("insert into factory.hosting_sites(site_id,address,revision_id) values($1,'203.0.113.10',$2)",[site.id,versions[6]]);
  await hosting.enqueue(actor,site.id,{action:'prune'});await hosting.tick();expect((await hosting.details(site.id)).jobs[0].status).toBe('failed');expect((await pool.query('select 1 from private.payload_pins where id=any($1::uuid[])',[versions])).rowCount).toBe(7);
  fail=false;await hosting.retry(actor,site.id);await hosting.tick();expect((await hosting.details(site.id)).jobs[0].phase).toBe('pruned');expect(new Set(kept.at(-1))).toEqual(new Set(versions.slice(2)));expect((await pool.query('select 1 from private.payload_pins where id=any($1::uuid[])',[versions])).rowCount).toBe(5);await expect(hosting.enqueue(actor,site.id,{action:'rollback',revisionId:versions[0]!})).rejects.toThrow(/успешно/);await hosting.enqueue(actor,site.id,{action:'rollback',revisionId:versions[2]!});await hosting.tick();expect((await hosting.details(site.id)).binding.revision_id).toBe(versions[2]);
 }finally{await hosting.close();}
},30000);

test.skipIf(!enabled)('full encrypted backup restores factory data, files and portable secrets into a fresh database with operations held',async()=>{
 const auth=new LocalAuth(pool);const registration=await auth.register({login:'backup_owner',password:'fixture-only-long-password',invite:''},true);await auth.invite(registration.userId);
 const secret='fixture-api-secret-'+randomUUID();await pool.query("insert into factory.settings values('deepseek',$1)",[await protectSecret(secret)]);
 const c={databasePort:connection.port,databasePassword:await protectSecret(connection.password),publicOrigin:'https://fixture.example:9443',tlsPort:9443,tlsPfx:await protectSecret('fixture-pfx'),tlsPassword:await protectSecret('fixture-tls-password')};await writeFile(join(data,'config.json'),JSON.stringify(c));
 const large=Buffer.alloc(4*1024*1024+777,17);await mkdir(join(data,'objects'),{recursive:true});await writeFile(join(data,'objects','boundary.bin'),large);
 await mkdir(join(data,'ssh'),{recursive:true});await writeFile(join(data,'ssh/diagnostic.log'),'old verification');await writeFile(join(data,'ssh/report.json'),Buffer.from('\ufeff{}','utf16le'));await writeFile(join(data,'ssh/legacy.json'),JSON.stringify({privateKeyEncrypted:await protectSecret('fixture-legacy-key')}));
 const password='fixture-backup-password-'+randomUUID(),backup=await captureWindowsBackup({pool,root,data,connection:{...connection,database:id},password});
 expect((await readFile(backup.file)).includes(Buffer.from(secret))).toBe(false);
 const targetDb='sf_restore_'+randomUUID().replaceAll('-',''),destination=join(data,'restored'),calls:string[]=[];
 try{
  const result=await restoreWindowsBackup({root,archive:backup.file,password,destination,database:targetDb,connection,codec:async(value,decrypt)=>{expect(decrypt).not.toBe(true);calls.push('encrypt');return protectSecret(value);}});expect(result.held).toBe(true);expect(calls.length).toBeGreaterThan(4);
  const target=new Pool({...connection,database:targetDb});try{
   expect((await target.query('select count(*) n from factory.hosting_hosts')).rows[0].n).toBe((await pool.query('select count(*) n from factory.hosting_hosts')).rows[0].n);
   expect((await target.query('select count(*) n from factory.hosting_jobs')).rows[0].n).toBe((await pool.query('select count(*) n from factory.hosting_jobs')).rows[0].n);
   expect((await target.query('select 1 from factory.sessions')).rowCount).toBe(0);expect((await target.query('select 1 from factory.invites where used_at is null')).rowCount).toBe(0);expect((await target.query("select value from factory.system_state where key='recovery_hold'")).rows[0].value).toBe(true);
   const restoredSecret=(await target.query("select value from factory.settings where key='deepseek'")).rows[0].value;expect(await protectSecret(restoredSecret,true)).toBe(secret);
   expect((await new LocalAuth(target).login('backup_owner','fixture-only-long-password')).userId).toBe(registration.userId);
   const repo=new SupabaseRepository(configureSnapshotConnection(target,'direct')),files=new R2Store(repo,new FileObjectTransport(join(destination,'data/objects')),new PostgresQueue(repo));for(const row of (await target.query('select manifest_id from public.revisions')).rows)expect((await files.read(row.manifest_id))[0]?.path).toBe('index.html');
   expect(await readFile(join(destination,'data/objects/boundary.bin'))).toEqual(large);
   const heldRuntime=await createServerRuntime(target,join(destination,'source'),join(destination,'data'),'https://fixture.example:9443');try{expect(heldRuntime.recoveryState().held).toBe(true);expect(heldRuntime.status().running).toBe(false);await Promise.all([heldRuntime.servers.tick(),heldRuntime.hosting.tick(),heldRuntime.monitoring.tick()]);expect((await target.query("select count(*) n from factory.hosting_health")).rows[0].n).toBe('0');}finally{await heldRuntime.close();}
  }finally{await target.end();}

  const linuxDb='sf_restore_'+randomUUID().replaceAll('-',''),backDb='sf_restore_'+randomUUID().replaceAll('-',''),linuxDir=join(data,'linux-restored'),backDir=join(data,'windows-again'),keyPath=join(data,'linux-key');
  await writeFile(keyPath,randomBytes(32),{mode:0o600});const linuxCodec=linuxSecretCodec(keyPath);
  try{
   await restoreWindowsBackup({root,archive:backup.file,password,destination:linuxDir,database:linuxDb,connection,codec:linuxCodec});
   const linuxPool=new Pool({...connection,database:linuxDb});let portable;
   try{
    expect(await linuxCodec((await linuxPool.query("select value from factory.settings where key='deepseek'")).rows[0].value,true)).toBe(secret);
    expect((await new LocalAuth(linuxPool).login('backup_owner','fixture-only-long-password')).userId).toBe(registration.userId);
    portable=await captureWindowsBackup({pool:linuxPool,root,data:join(linuxDir,'data'),connection:{...connection,database:linuxDb},password,codec:linuxCodec});
   }finally{await linuxPool.end();}
   await restoreWindowsBackup({root,archive:portable.file,password,destination:backDir,database:backDb,connection});
   const backPool=new Pool({...connection,database:backDb});try{expect(await protectSecret((await backPool.query("select value from factory.settings where key='deepseek'")).rows[0].value,true)).toBe(secret);expect((await new LocalAuth(backPool).login('backup_owner','fixture-only-long-password')).userId).toBe(registration.userId);}finally{await backPool.end();}
  }finally{await admin.query('drop database if exists '+linuxDb+' with (force)');await admin.query('drop database if exists '+backDb+' with (force)');await removePrivateTree(data,linuxDir);await removePrivateTree(data,backDir);}
  await expect(restoreWindowsBackup({root,archive:backup.file,password,destination,database:targetDb,connection})).rejects.toThrow(/существует/);
  const corrupt=join(data,'corrupt.sfbak'),bytes=await readFile(backup.file);bytes[1000]=bytes[1000]!^1;await writeFile(corrupt,bytes);
  for(const [file,pass] of [[backup.file,'wrong-password-value'],[corrupt,password]])await expect(restoreWindowsBackup({root,archive:file!,password:pass!,destination:join(data,'bad-restore'),database:'sf_restore_bad_'+id.slice(-10),connection})).rejects.toThrow();
  expect((await admin.query('select 1 from pg_database where datname=$1',['sf_restore_bad_'+id.slice(-10)])).rowCount).toBe(0);
  expect((await readdir(join(data,'recovery'))).some(f=>f.startsWith('work-')||f.startsWith('.backup-')||f.startsWith('.restore-'))).toBe(false);
 }finally{await admin.query('drop database if exists '+targetDb+' with (force)');await removePrivateTree(data,destination);}
},180000);


test.skipIf(!enabled)('restore imports a newer remote release and advances publication order before resume',async()=>{
 const {reconcileRecovery}=await import('../src/recovery-reconcile.js');
 const site=await repository.create({domain:'restore-release.example'},actor),old=await version(site.id,'backup'),remote=randomUUID();
 await pool.query("insert into factory.hosting_addresses(address,host_id,site_id,state) values('203.0.113.99','a',$1,'active')",[site.id]);
 await pool.query("insert into factory.hosting_sites(site_id,address,revision_id) values($1,'203.0.113.99',$2)",[site.id,old]);
 const bindings=(await pool.query('select b.*,s.domain,host(b.address) ip from factory.hosting_sites b join public.sites s on s.id=b.site_id')).rows;
 const read=async(_host:any,id:string)=>{const row=bindings.find(b=>b.site_id===id);return {siteId:id,domain:row.domain,revisionId:id===site.id?remote:row.revision_id,ips:[row.ip],order:'9000'};};
 await reconcileRecovery(pool,read,store,async()=>[{path:'index.html',bytes:Buffer.from('<h1>New live release</h1>'),mediaType:'text/html'}],async()=>[]);
 expect((await repository.get(site.id))!.draftId).toBe(remote);
 const revision=await repository.revision(remote);expect(Buffer.from((await store.read(revision!.manifestId))[0]!.bytes).toString()).toContain('New live release');
 expect(Number((await pool.query("select nextval(pg_get_serial_sequence('factory.hosting_jobs','id')) n")).rows[0].n)).toBeGreaterThan(9000);
});

test.skipIf(!enabled)('DNS cooldown is shared by new transport instances and survives process restart',async()=>{
 const {dnsTransport}=await import('../src/dns-transport.js');let calls=0;
 const transport:any=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'60'}});};
 const first=dnsTransport(pool,'godaddy','quota-fixture',transport);await first('https://fixture.example');
 const restarted=dnsTransport(pool,'godaddy','quota-fixture',transport);await expect(restarted('https://fixture.example')).rejects.toMatchObject({code:'UNAVAILABLE'});expect(calls).toBe(1);
});


test.skipIf(!enabled)('model budget is atomic across concurrent requests and persists after restart',async()=>{
 const {reserveModelBudget}=await import('../src/model-budget.js');
 const site=await repository.create({domain:'model-budget.example'},actor),job=randomUUID();
 await pool.query("insert into private.jobs(id,site_id,data) values($1,$2,$3)",[job,site.id,{state:'running'}]);
 const limits={job:32000,batch:32000},signal=new AbortController().signal;
 const outcomes=await Promise.allSettled([reserveModelBudget(pool,job,site.id,20000,limits,signal),reserveModelBudget(pool,job,site.id,20000,limits,signal)]);
 expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(Number((await pool.query('select reserved from factory.model_budgets where key=$1',['job:'+job])).rows[0].reserved)).toBe(20000);
 await expect(reserveModelBudget(pool,job,site.id,20000,limits,signal)).rejects.toMatchObject({code:'NEEDS_ATTENTION'});
 await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"cancelled\"') where id=$1",[job]);
 await expect(reserveModelBudget(pool,job,site.id,1,limits,signal)).rejects.toMatchObject({code:'STALE_LEASE'});
});

test.skipIf(!enabled)('model budget settles confirmed calls in both scopes and keeps uncertain calls reserved',async()=>{
 const {budgetedModel}=await import('../src/model-budget.js');
 const site=await repository.create({domain:'metered-budget.example'},actor),job=randomUUID(),batch=randomUUID();
 await pool.query("insert into private.batches(id,owner_id,state,data) values($1,$2,'active','{}')",[batch,actor.userId]);
 await pool.query("insert into private.jobs(id,site_id,batch_id,data) values($1,$2,$3,$4)",[job,site.id,batch,{state:'running'}]);
 let usage:object|undefined={input_tokens:15,output_tokens:7,total_tokens:22};
 const run=async()=>{
  const model=budgetedModel(pool,'fixture',{job:32000,batch:32000},async()=>Response.json({status:'completed',usage,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Ready.'}]}]}));
  return model.run({mode:'plan',site,instruction:'Choose a topic',styleId:'fixture',baseManifestId:null,conversation:[],operationId:job}, {list:async()=>[],read:async()=>'',write:async()=>{},replace:async()=>{}},new AbortController().signal);
 };
 const totals=async()=>(await pool.query('select reserved from factory.model_budgets where key=any($1) order by key',[['batch:'+batch,'job:'+job]])).rows.map(r=>Number(r.reserved));
 await run();await run();
 expect(await totals()).toEqual([44,44]);
 usage=undefined;
 await run();const [batchTotal,jobTotal]=await totals();expect(batchTotal).toBe(jobTotal);expect(jobTotal).toBeGreaterThan(16044);
 await expect(run()).rejects.toThrow('Model token budget exhausted');
 expect(await totals()).toEqual([batchTotal,jobTotal]);
});


test.skipIf(!enabled)('restored service timers start paused before their first tick',async()=>{
 const site=await repository.create({domain:'held-start.example'},actor);await version(site.id,'held');
 await pool.query("insert into factory.hosting_addresses(address,host_id) values('203.0.113.98','a')");
 let calls=0;const external=async()=>{calls++;throw Error('Held services must not perform external work');};
 const hosting=await createHosting(pool,repository,store,data,{publish:external,dns:{read:external,write:external},propagated:external,health:external},true);
 const monitoring=await createMonitoring(pool,{dns:external,health:external,certificate:external},true);
 const servers=await createServers(pool,root,data,{execute:external,fingerprint:external},true);
 try{
  await hosting.enqueue(actor,site.id,{address:'203.0.113.98'});
  await pool.query("update factory.hosting_hosts set status='queued',phase='maintenance',operation=$1 where id='ops'",[{kind:'check',previousStatus:'ready'}]);
  await Promise.all([hosting.tick(),monitoring.tick(),servers.tick()]);await new Promise(r=>setTimeout(r,3200));
  expect(calls).toBe(0);expect((await hosting.details(site.id)).jobs[0].status).toBe('queued');
 }finally{await hosting.close();await monitoring.close();await servers.close();await pool.query("update factory.hosting_hosts set status='ready',phase='ready',operation=null where id='ops'");}
});
