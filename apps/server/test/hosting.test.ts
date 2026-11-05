import {PostgresBatches} from '../../../packages/adapters/src/postgres-batches.js';
import {AppError} from '../../../packages/contracts/src/model.js';
import {beforeAll,afterAll,test,expect,vi} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {migrate} from '../src/migrate.js';
import {protectSecret} from '../src/secrets.js';
import {createHosting,transientPublicationError} from '../src/hosting.js';
import type {HostingPorts} from '../src/hosting.js';
import {mergeIPv4,parseNamecheap,zoneHash,NamecheapDns} from '../src/namecheap.js';
import type {DnsZone} from '../src/namecheap.js';
import {SupabaseRepository,configureSnapshotConnection} from '../../../packages/adapters/src/supabase-repository.js';
import {R2Store} from '../../../packages/adapters/src/r2-store.js';
import {PostgresQueue} from '../../../packages/adapters/src/postgres-queue.js';
import {FileObjectTransport} from '../src/file-store.js';
import {GoDaddyDns} from '../src/godaddy.js';
import {createServers,validateServer} from '../src/servers.js';

test('publication retries transient GoDaddy and release-health failures, keeps configuration failures terminal',()=>{
 for(const message of ['GoDaddy не ответил. Повторите позже.','GoDaddy HTTP 503.','GoDaddy HTTP 429.','Проверка опубликованной версии не прошла.'])expect(transientPublicationError(new AppError('UNAVAILABLE',message))).toBe(true);
 for(const message of ['GoDaddy HTTP 401.','GoDaddy HTTP 403.','DNS изменился перед записью.','Command failed: nginx: invalid configuration'])expect(transientPublicationError(new AppError('UNAVAILABLE',message))).toBe(false);
});

test('GoDaddy paginates and only replaces apex A, preserves SRV/CAA and rejects concurrent edits',async()=>{
  let records=[{recordId:'a1',type:'A',name:'@',data:'192.0.2.4',ttl:600},{recordId:'mx',type:'MX',name:'@',data:'mail.example.',ttl:3600,priority:20},{recordId:'srv',type:'SRV',name:'@',data:'sip.example.',ttl:3600,priority:10,weight:20,port:5060,service:'_sip',protocol:'_tcp'},{recordId:'caa',type:'CAA',name:'@',data:'letsencrypt.org',ttl:3600,flag:0,tag:'issue'}];
  const writes:{url:string;body:unknown}[]=[];
  const dns=new GoDaddyDns('fixture-token',async(input,init)=>{
    const url=new URL(String(input));expect(url.hostname).toBe('api.godaddy.com');expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer fixture-token');
    if(init?.method==='PUT'){const body=JSON.parse(String(init.body));writes.push({url:url.pathname,body});records[0]={...records[0]!,...body};return Response.json(records[0]);}
    expect(init?.method).toBe('GET');const page=Number(url.searchParams.get('page'));return Response.json({items:records.slice((page-1)*2,page*2),totalItems:records.length,totalPages:Math.ceil(records.length/2)});
  });
  const before=await dns.read('fixture.example'),after=mergeIPv4(before,'192.0.2.9','600');await dns.write(after,before);
  expect(writes).toHaveLength(1);expect(writes[0]!.url).toBe('/v3/domains/zones/fixture.example/dns-records/a1');expect(writes[0]!.body).toEqual({name:'@',type:'A',data:'192.0.2.9',ttl:600});expect(zoneHash(await dns.read('fixture.example'))).toBe(zoneHash(after));expect(records[2]!.port).toBe(5060);
  const newer=await dns.read('fixture.example');records[0]!.data='192.0.2.20';await expect(dns.write(mergeIPv4(newer,'192.0.2.30','600'),newer)).rejects.toThrow(/изменился/);expect(writes).toHaveLength(1);
  records.push({recordId:'a2',type:'A',name:'@',data:'192.0.2.21',ttl:600});await expect(dns.write(mergeIPv4(await dns.read('fixture.example'),'192.0.2.30','600'))).rejects.toThrow(/несколько/);expect(writes).toHaveLength(1);
});
test('SSH form rejects internal addresses and unsafe usernames',()=>{
  const valid={name:'Test',host:'203.0.113.20',username:'ubuntu',password:'fixture-secret'};
  expect(validateServer(valid).port).toBe(22);
  for(const host of ['127.0.0.1','169.254.169.254','10.0.0.2','192.168.0.3'])expect(()=>validateServer({...valid,host})).toThrow();
  expect(()=>validateServer({...valid,username:'ubuntu; id'})).toThrow();
});

const initial:DnsZone={domain:'chinazes.space',emailType:'FWD',records:[{Name:'@',Type:'URL',Address:'http://www.chinazes.space/',TTL:'1800',MXPref:'10'},{Name:'@',Type:'MX',Address:'mail.example.',TTL:'1800',MXPref:'20'},{Name:'@',Type:'TXT',Address:'v=spf1 include:mail.example ~all',TTL:'1800',MXPref:'10'},{Name:'www',Type:'CNAME',Address:'parking.example.',TTL:'1800',MXPref:'10'}]};
test('DNS merge preserves MX, TXT, subdomains, mail mode and blocks incompatible AAAA',()=>{
  const merged=mergeIPv4(initial,'192.0.2.10');expect(merged.records.slice(0,3)).toEqual(initial.records.slice(1));expect(merged.emailType).toBe('FWD');expect(merged.records.at(-1)?.Address).toBe('192.0.2.10');expect(initial.records[0]?.Type).toBe('URL');
  expect(()=>mergeIPv4({...initial,records:[...initial.records,{Name:'@',Type:'AAAA',Address:'2001:db8::1',TTL:'300',MXPref:'10'}]},'192.0.2.10')).toThrow(/AAAA/);
  expect(parseNamecheap('<ApiResponse Status="OK"><Host Name="@" Type="TXT" Address="a &amp; &quot;b&quot;"/></ApiResponse>')[1]?.attrs.Address).toBe('a & "b"');
  expect(()=>parseNamecheap('<!DOCTYPE root><ApiResponse Status="OK"/>')).toThrow();
});
test('unapproved domains are rejected before DNS transport',async()=>{
  let called=false;const dns=new NamecheapDns({username:'fixture',apiKey:'fixture',clientIp:'192.0.2.1'},async()=>{called=true;throw Error('must not call');});await expect(dns.read('unapproved.example')).rejects.toThrow();expect(called).toBe(false);
});

const enabled=process.env.SITE_FACTORY_SERVER_TEST==='1',id='sf_hosting_'+randomUUID().replaceAll('-',''),root=resolve('.'),data=resolve('.local-state',id),actor={userId:randomUUID(),role:'admin' as const};
let admin:Pool,pool:Pool,repository:SupabaseRepository,store:R2Store,hosting:Awaited<ReturnType<typeof createHosting>>;
beforeAll(async()=>{if(!enabled)return;const config=JSON.parse(await readFile('.local-state/server/config.json','utf8'));const connection={host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true)};admin=new Pool({...connection,database:'postgres'});await admin.query('create database '+id);pool=new Pool({...connection,database:id,max:10});await mkdir(data,{recursive:true});await migrate(pool,root);await pool.query('insert into auth.users values($1)',[actor.userId]);await pool.query('insert into public.users(id) values($1)',[actor.userId]);await pool.query("insert into public.memberships values($1,'admin',true)",[actor.userId]);repository=new SupabaseRepository(configureSnapshotConnection(pool,'direct'));store=new R2Store(repository,new FileObjectTransport(join(data,'objects')),new PostgresQueue(repository));await pool.query("insert into factory.hosting_addresses(address,host_id) values('192.0.2.10','fixture'),('192.0.2.11','fixture')");},60000);
afterAll(async()=>{if(!enabled)return;await hosting?.close();await pool?.end();if(admin){await admin.query('drop database '+id);await admin.end();}},30000);
async function version(siteId:string,text:string){const revision=randomUUID(),manifest=await store.put(siteId,[{path:'index.html',bytes:Buffer.from('<h1>'+text+'</h1>'),mediaType:'text/html'}],'fixture');await pool.query("insert into public.revisions values($1,$2,null,$3,'draft',$4)",[revision,siteId,manifest.id,Date.now()]);await pool.query('update public.sites set draft_id=$2 where id=$1',[siteId,revision]);return revision;}
test.skipIf(!enabled)('durable publication: allocation race, restart, update, rollback, replacement, DNS conflict',async()=>{
  const site=await repository.create({domain:'chinazes.space'},actor),other=await repository.create({domain:'gucci777.shop'},actor);const v1=await version(site.id,'one');await version(other.id,'other');
  let zone=structuredClone(initial),ready=false,uploads=0,writes=0,active='',conflict=false,reads=0;
  const ports:HostingPorts={async publish(target,files){if(files){uploads++;active=target.revisionId;}},dns:{async read(){reads++;if(conflict&&reads===2)zone.records.push({Name:'external',Type:'TXT',Address:'new',TTL:'300',MXPref:'10'});return structuredClone(zone);},async write(value){writes++;zone=structuredClone(value);}},async propagated(){return ready;},async health(_domain,_ip,revision){expect(active).toBe(revision);}};
  hosting=await createHosting(pool,repository,store,data,ports);
  const race=await Promise.allSettled([hosting.enqueue(actor,site.id,{address:'192.0.2.10'}),hosting.enqueue(actor,site.id,{address:'192.0.2.10'})]);expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await expect(hosting.enqueue(actor,other.id,{address:'192.0.2.10'})).rejects.toThrow(/занят/);
  await hosting.tick();expect((await hosting.details(site.id)).jobs[0].status).toBe('waiting');expect(uploads).toBe(1);expect(writes).toBe(1);
  await hosting.close();hosting=await createHosting(pool,repository,store,data,ports);ready=true;await pool.query('update factory.hosting_jobs set next_attempt=now()');await hosting.tick();expect((await hosting.details(site.id)).jobs[0].status).toBe('complete');expect(uploads).toBe(1);
  const v2=await version(site.id,'two');await hosting.enqueue(actor,site.id,{});await hosting.tick();expect(active).toBe(v2);expect((await hosting.details(site.id)).binding.address).toBe('192.0.2.10');
  await hosting.enqueue(actor,site.id,{action:'rollback',revisionId:v1});await hosting.tick();expect(active).toBe(v1);expect((await hosting.details(site.id)).binding.address).toBe('192.0.2.10');
  expect((await pool.query("select 1 from private.payload_pins where id=$1 and expires_at='infinity'",[v1])).rowCount).toBe(1);
  await hosting.enqueue(actor,site.id,{action:'replace',revisionId:v2,address:'192.0.2.11'});await hosting.tick();expect((await hosting.details(site.id)).jobs[0].status).toBe('complete');expect((await hosting.details(site.id)).binding.address).toBe('192.0.2.11');expect((await pool.query('select address from factory.hosting_addresses where site_id=$1',[site.id])).rowCount).toBe(2);
  const beforeRollback={reads,writes};
  const offline={...ports,dns:{read:async()=>{throw Error('DNS offline');},write:async()=>{throw Error('DNS write forbidden');}},propagated:async()=>{throw Error('DNS resolution forbidden');},publish:async(target,files)=>{expect(files).toBeDefined();await ports.publish(target,files);},health:async(domain,ip,revision,tls)=>{expect(tls).toBe(false);await ports.health(domain,ip,revision,tls);}} satisfies HostingPorts;
  await hosting.close();hosting=await createHosting(pool,repository,store,data,offline);
  await expect(hosting.enqueue(actor,site.id,{action:'rollback',revisionId:v1,address:'192.0.2.10'})).rejects.toThrow(/смены IPv4/);
  await hosting.enqueue(actor,site.id,{action:'rollback',revisionId:v1});
  // Resume an old-style interrupted rollback at a DNS phase as a file operation.
  await pool.query("update factory.hosting_jobs set status='running',phase='dns' where site_id=$1 and status='queued'",[site.id]);
  await hosting.tick();
  expect((await hosting.details(site.id)).jobs[0]).toMatchObject({status:'complete',phase:'rolled_back'});
  expect((await hosting.details(site.id)).binding).toMatchObject({address:'192.0.2.11',revision_id:v1});expect(active).toBe(v1);expect({reads,writes}).toEqual(beforeRollback);
  await hosting.close();hosting=await createHosting(pool,repository,store,data,ports);
  const count=writes;conflict=true;reads=0;zone=structuredClone(initial);await hosting.enqueue(actor,site.id,{});await hosting.tick();expect((await hosting.details(site.id)).jobs[0].status).toBe('failed');expect((await hosting.details(site.id)).jobs[0].error).toMatch(/DNS изменился/);expect(writes).toBe(count);expect(zone.records.some(r=>r.Name==='external')).toBe(true);
  expect(zoneHash(zone)).not.toBe(zoneHash(initial));
},60000);

test.skipIf(!enabled)('allocation honors selected host and failed first upload permits correcting DNS provider',async()=>{
  await hosting?.close();
  await pool.query("insert into factory.hosting_addresses(address,host_id) values('198.51.100.20','host-a'),('198.51.100.21','host-b')");
  const site=await repository.create({domain:'routing.example'},actor);await version(site.id,'routing');
  hosting=await createHosting(pool,repository,store,data,{publish:async()=>{throw Error('offline fixture');},dns:{read:async()=>({domain:site.domain,records:[]}),write:async()=>{}},propagated:async()=>true,health:async()=>{}});
  await hosting.enqueue(actor,site.id,{serverId:'host-b'});await hosting.tick();
  expect((await hosting.details(site.id)).jobs[0].address).toBe('198.51.100.21');expect((await hosting.details(site.id)).provider).toBe('godaddy');
  await expect(hosting.enqueue(actor,site.id,{serverId:'host-a'})).rejects.toThrow(/миграции/);
  await hosting.enqueue(actor,site.id,{provider:'namecheap'});await hosting.tick();expect((await hosting.details(site.id)).provider).toBe('namecheap');
},60000);

test.skipIf(!enabled)('server provisioning encrypts bootstrap, pins identity and recovers interrupted network stage',async()=>{
  const actions:string[]=[];let networkArmed=false,failOnce=true,fingerprints=0;
  const servers=await createServers(pool,root,data,{fingerprint:async()=>{fingerprints++;return 'SHA256:'+'a'.repeat(43);},execute:async(_host,command,input)=>{
    if(command.includes('$SSH_CONNECTION'))return '203.0.113.1 40000 203.0.113.20 22';
    if(input){const p=JSON.parse(input);actions.push(p.action);if(p.action==='network'){networkArmed=true;return JSON.stringify({ok:true,rollback:'fixture-net'});}if(p.action==='firewall')return JSON.stringify({ok:true,rollback:'fixture-fw'});if(p.action==='recover-network')networkArmed=false;return JSON.stringify({ok:true,os:'Fixture Linux',ready:true});}
    if(networkArmed&&failOnce){failOnce=false;throw new Error('Simulated connection interruption');}return '';
  }});
  try{
    const {id:serverId}=await servers.add({name:'Fixture VPS',host:'203.0.113.20',username:'root',password:'private-bootstrap-test',additionalIPv4:'203.0.113.21'});
    const saved=(await pool.query('select * from factory.hosting_hosts where id=$1',[serverId])).rows[0];expect(saved.bootstrap).not.toContain('private-bootstrap-test');expect(saved.credential).not.toContain('PRIVATE KEY');
    await servers.tick();expect((await servers.list()).find(h=>h.id===serverId).status).toBe('failed');expect((await pool.query('select bootstrap from factory.hosting_hosts where id=$1',[serverId])).rows[0].bootstrap).toBeNull();
    await servers.close();const resumed=await createServers(pool,root,data,{fingerprint:async()=>{throw Error('must preserve pin');},execute:async(_host,_command,input)=>{if(input){const p=JSON.parse(input);actions.push(p.action);return JSON.stringify({ok:true,rollback:['network','firewall'].includes(p.action)?'fixture':null,ready:true});}return '';}});
    try{await resumed.retry(serverId);await resumed.tick();const result=(await resumed.list()).find(h=>h.id===serverId);expect(result.status).toBe('ready');expect(result).not.toHaveProperty('credential');expect(result).not.toHaveProperty('bootstrap');expect(fingerprints).toBe(1);expect(actions.filter(a=>a==='packages')).toHaveLength(1);expect(actions.filter(a=>a==='recover-network')).toHaveLength(2);expect(actions).toContain('confirm-firewall');}finally{await resumed.close();}
  }finally{await servers.close();}
},60000);

test.skipIf(!enabled)('host queues run independently and serialize publications on the same VPS',async()=>{
 await hosting?.close();
 await pool.query("insert into factory.hosting_addresses(address,host_id) values('198.51.100.30','queue-a'),('198.51.100.31','queue-a'),('198.51.100.32','queue-b')");
 const sites:Awaited<ReturnType<typeof repository.create>>[]=[];for(const domain of ['queue-one.example','queue-two.example','queue-three.example']){const site=await repository.create({domain},actor);await version(site.id,domain);sites.push(site);}
 let release!:()=>void,second!:()=>void,firstStarted!:()=>void;const firstReady=new Promise<void>(r=>firstStarted=r);const blocked=new Promise<void>(r=>release=r),otherStarted=new Promise<void>(r=>second=r),started:string[]=[];const zones=new Map<string,DnsZone>();
 hosting=await createHosting(pool,repository,store,data,{publish:async(t,files)=>{if(!files)return;started.push(t.domain);if(t.domain===sites[0]!.domain){firstStarted();await blocked;}if(t.domain===sites[2]!.domain)second();},dns:{read:async d=>structuredClone(zones.get(d)??{domain:d,records:[]}),write:async z=>{zones.set(z.domain,structuredClone(z));}},propagated:async()=>true,health:async()=>{}});
 try{
  await hosting.enqueue(actor,sites[0]!.id,{serverId:'queue-a'});await hosting.enqueue(actor,sites[1]!.id,{serverId:'queue-a'});await hosting.enqueue(actor,sites[2]!.id,{serverId:'queue-b'});
  const first=hosting.tick();await Promise.race([Promise.all([otherStarted,firstReady]),new Promise((_,reject)=>setTimeout(()=>reject(Error('Other VPS was blocked')),10000))]);expect(started).toContain(sites[0]!.domain);expect(started).not.toContain(sites[1]!.domain);release();await first;await hosting.tick();expect(started).toContain(sites[1]!.domain);
 }finally{release();await hosting.close();}
},30000);

test.skipIf(!enabled)('preflight is read-only, respects exclusions and rejects missing drafts',async()=>{
 await hosting?.close();await pool.query("insert into factory.hosting_hosts(id,name,host,port,username,host_fingerprint,credential,config,status,phase) values('preflight','preflight','203.0.113.50',22,'ubuntu','fixture','fixture','{}','ready','ready')");await pool.query("insert into factory.hosting_addresses(address,host_id) values('203.0.113.50','preflight')");
 const site=await repository.create({domain:'preflight.example'},actor);let writes=0;
 hosting=await createHosting(pool,repository,store,data,{publish:async()=>{writes++;},dns:{read:async domain=>({domain,records:[]}),write:async()=>{writes++;}},propagated:async()=>true,health:async()=>{}});
 await expect(hosting.preflight(actor,site.id)).rejects.toThrow(/черновика/);const revisionId=await version(site.id,'ready');const before=(await pool.query('select count(*) n from factory.hosting_jobs')).rows[0].n;
 const excluded=(await pool.query("select host(address) address from factory.hosting_addresses where address<>'203.0.113.50'")).rows.map(r=>r.address as string);const plan=await hosting.preflight(actor,site.id,excluded);expect(plan).toMatchObject({revisionId,address:'203.0.113.50',provider:'godaddy'});await expect(hosting.preflight(actor,site.id,[...excluded,plan.address])).rejects.toThrow(/IPv4/);expect(writes).toBe(0);expect((await pool.query('select count(*) n from factory.hosting_jobs')).rows[0].n).toBe(before);expect((await pool.query("select site_id from factory.hosting_addresses where address='203.0.113.50'")).rows[0].site_id).toBeNull();
},30000);

test('dedicated inventory accepts 256 additional IPv4 and rejects excess',()=>{
 const ips=Array.from({length:257},(_,i)=>'203.0.'+(114+Math.floor(i/254))+'.'+(i%254+1));const body={host:'203.0.120.1',username:'ubuntu',name:'Dedicated',password:'fixture'};
 expect(validateServer({...body,additionalIPv4:ips.slice(0,256).join(' ')}).additionalIPv4).toHaveLength(256);expect(()=>validateServer({...body,additionalIPv4:ips.join(' ')})).toThrow(/256/);
});
test('concurrent host queues reserve distinct Namecheap rate slots',async()=>{
 vi.useFakeTimers();const sent:number[]=[];
 try{const dns=new NamecheapDns({username:'fixture',apiKey:'fixture',clientIp:'203.0.113.1'},async()=>{sent.push(Date.now());return new Response('<ApiResponse Status="OK"><DomainDNSGetHostsResult Domain="rate.example" IsUsingOurDNS="true"/></ApiResponse>');},['rate.example']);const calls=Promise.all([dns.read('rate.example'),dns.read('rate.example'),dns.read('rate.example')]);await vi.advanceTimersByTimeAsync(13000);await calls;expect(sent).toHaveLength(3);expect(sent[1]!-sent[0]!).toBeGreaterThanOrEqual(6100);expect(sent[2]!-sent[1]!).toBeGreaterThanOrEqual(6100);}finally{vi.useRealTimers();}
});

test.skipIf(!enabled)('one-click creation reserves IPv4 atomically and publishes once after restart',async()=>{
  await hosting?.close();
  await pool.query("insert into factory.hosting_addresses(address,host_id) values('203.0.113.80','automatic-fixture')");
  let writes=0,uploads=0;let zone:DnsZone={domain:'automatic.example',records:[]};
  const ports:HostingPorts={publish:async()=>{uploads++;},dns:{read:async domain=>({...structuredClone(zone),domain}),write:async value=>{writes++;zone=structuredClone(value);}},propagated:async()=>true,health:async()=>{}};
  hosting=await createHosting(pool,repository,store,data,ports);await hosting.pause();
  const site=await hosting.createSite(actor,{domain:'automatic.example'});
  expect((await hosting.details(site.id)).automatic?.status).toBe('waiting');
  expect((await hosting.details(site.id)).addresses).toHaveLength(1);
  expect(uploads).toBe(0);expect(writes).toBe(0);
  await version(site.id,'automatic');
  await pool.query("update private.jobs set data=jsonb_set(data,'{state}',to_jsonb($2::text)) where site_id=$1",[site.id,'completed']);
  await hosting.close();hosting=await createHosting(pool,repository,store,data,ports);
  await hosting.tick();await hosting.tick();
  const result=await hosting.details(site.id);
  expect(result.automatic?.status).toBe('submitted');expect(result.jobs).toHaveLength(1);expect(result.jobs[0].status,result.jobs[0].error??'').toBe('complete');expect(writes).toBe(1);expect(uploads).toBe(2);
  await hosting.pause();
  await pool.query("update factory.hosting_addresses set state='draining' where site_id is null");
  await expect(hosting.createSite(actor,{domain:'no-capacity.example'})).rejects.toThrow(/свободного IPv4/);
  expect((await pool.query("select 1 from public.sites where domain='no-capacity.example'")).rowCount).toBe(0);
},60000);

test.skipIf(!enabled)('batch waits for capacity without model jobs, reserves distinct IPv4 before generation and retries DNS after restart',async()=>{
 await hosting?.close();await pool.query("update factory.hosting_addresses set state='draining' where site_id is null");
 let writes=0;const zones=new Map<string,DnsZone>();let fail=true;
 const ports:HostingPorts={publish:async()=>{},dns:{read:async domain=>structuredClone(zones.get(domain)??{domain,records:[]}),write:async zone=>{writes++;if(fail){fail=false;throw new AppError('UNAVAILABLE','GoDaddy HTTP 503.');}zones.set(zone.domain,structuredClone(zone));}},propagated:async()=>true,health:async()=>{}};
 hosting=await createHosting(pool,repository,store,data,ports);
 repository.canAdmitBatchSite=hosting.canAdmitBatchSite;repository.onBatchSiteCreated=hosting.reserveBatchSite;
 const batches=new PostgresBatches(repository);
 try{
  const batch=await batches.submitBatch(actor,[{rowNumber:2,domain:'capacity-one.example',mentionedUrl:'https://www.example.com/guide'},{rowNumber:3,domain:'capacity-two.example',mentionedUrl:'https://www.example.com/guide'}],randomUUID());
  expect(batch.siteIds).toHaveLength(0);expect((await pool.query('select 1 from private.jobs where batch_id=$1',[batch.batchId])).rowCount).toBe(0);
  await pool.query("insert into factory.hosting_addresses(address,host_id) values('203.0.113.90','batch-fixture'),('203.0.113.91','batch-fixture')");
  await batches.admit(actor,batch.batchId);
  const rows=await batches.rows(batch.batchId);expect(rows.every(r=>!!r.siteId)).toBe(true);
  const addresses=(await pool.query('select address,site_id,state from factory.hosting_addresses where site_id=any($1::uuid[])',[rows.map(r=>r.siteId)])).rows;
  expect(addresses).toHaveLength(2);expect(new Set(addresses.map(r=>r.address)).size).toBe(2);expect(addresses.every(r=>r.state==='reserved')).toBe(true);
  for(const r of rows){await version(r.siteId!,r.input.domain);await pool.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where site_id=$1",[r.siteId]);}
  await hosting.tick();const first=(await hosting.details(rows[0]!.siteId!)).jobs[0];expect(first.status).toBe('waiting');expect(first.phase).toBe('dns');
  await hosting.close();hosting=await createHosting(pool,repository,store,data,ports);await pool.query('update factory.hosting_jobs set next_attempt=now() where status=\'waiting\'');await hosting.tick();await hosting.tick();
  for(const r of rows){const d=await hosting.details(r.siteId!);expect(d.jobs).toHaveLength(1);expect(d.jobs[0].status).toBe('complete');expect(zones.get(r.input.domain)?.records.some(v=>v.Type==='A')).toBe(true);}
  expect(writes).toBe(3);
 }finally{delete repository.canAdmitBatchSite;delete repository.onBatchSiteCreated;}
},60000);

test.skipIf(!enabled)('deleting a preview checks owner, revision and refuses started batches',async()=>{
 const id=randomUUID(),batches=new PostgresBatches(repository),data={summary:{id,name:'Delete fixture',revision:1,state:'preview',total:0,validCount:0,invalidCount:0,canControl:true}};
 await pool.query("insert into private.batches(id,owner_id,state,data) values($1,$2,'preview',$3)",[id,actor.userId,data]);
 await expect(batches.request({userId:randomUUID(),role:'admin'},'batch.delete',{id,revision:1})).rejects.toThrow();
 await expect(batches.request(actor,'batch.delete',{id,revision:2})).rejects.toThrow(/Обновите/);
 await pool.query("update private.batches set state='active',data=jsonb_set(data,'{summary,state}',to_jsonb($2::text)) where id=$1",[id,'active']);
 await expect(batches.request(actor,'batch.delete',{id,revision:1})).rejects.toThrow(/незапущенную/);
 await pool.query("update private.batches set state='preview',data=$2 where id=$1",[id,data]);
 expect(await batches.request(actor,'batch.delete',{id,revision:1})).toEqual({ok:true});expect((await pool.query('select 1 from private.batches where id=$1',[id])).rowCount).toBe(0);
},30000);
