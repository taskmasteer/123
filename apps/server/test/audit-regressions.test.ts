import {test,expect,vi} from 'vitest';
import {zipSync,strToU8} from 'fflate';
import {createSiteUpload} from '../src/site-upload.js';
import {GoDaddyDns} from '../src/godaddy.js';
import {runWorker} from '../../worker/src/runner.js';
import {AppError} from '../../../packages/contracts/src/model.js';

test('completed ZIP receipts do not occupy active slots and lost chunk/commit responses can be retried',async()=>{
 let revision=1,puts=0;
 const repository={scoped:async()=>({domain:'fixture.example',revision,draftId:null}),get:async()=>({revision}),acquire:async()=>({}),release:async()=>{},guard:async()=>{},transaction:async(fn:any)=>fn({query:async(sql:string)=>{if(sql.startsWith('update public.sites'))revision++;return {rows:[]};}})};
 const call=createSiteUpload({repository,store:{put:async()=>{puts++;return {id:'manifest'};}}} as any),actor:any={userId:'owner'},bytes=Buffer.from(zipSync({'index.html':strToU8('<h1>Updated</h1>')}));
 for(let i=0;i<8;i++){
  const {id}=await call(actor,'site',{action:'begin',size:bytes.length}) as {id:string};
  const chunk={action:'chunk',id,offset:0,base64:bytes.toString('base64')};await call(actor,'site',chunk);await call(actor,'site',chunk);
  const result=await call(actor,'site',{action:'commit',id});expect(await call(actor,'site',{action:'commit',id})).toEqual(result);
 }
 expect(puts).toBe(8);
});
test('GoDaddy accepts omitted totals only for an empty first page',async()=>{
 expect(await new GoDaddyDns('fixture',async()=>Response.json({items:[]})).read('fixture.example')).toEqual({domain:'fixture.example',records:[]});
 await expect(new GoDaddyDns('fixture',async()=>Response.json({items:[{}]})).read('fixture.example')).rejects.toThrow();
});
test('temporary queue outage recovers without restarting the worker',async()=>{
 const abort=new AbortController();let calls=0;
 await runWorker({queue:{claim:async()=>{calls++;if(calls<=2)throw new AppError('UNAVAILABLE','Temporary outage');abort.abort();return null;}}} as any,'fixture',abort.signal);
 expect(calls).toBeGreaterThan(2);
});
test('worker does not retry a revoked identity',async()=>{
 await expect(runWorker({queue:{claim:async()=>{throw new AppError('UNAUTHENTICATED','Revoked');}}} as any,'fixture',new AbortController().signal)).rejects.toMatchObject({code:'UNAUTHENTICATED'});
});


test('ZIP rejects a missing stylesheet and supports static metadata',async()=>{
 const {readSiteZip}=await import('../src/site-upload.js');
 await expect(readSiteZip(Buffer.from(zipSync({'index.html':strToU8('<link rel="stylesheet" href="missing.css"><h1>Page</h1>')})))).rejects.toMatchObject({code:'INVALID_INPUT'});
 const files=await readSiteZip(Buffer.from(zipSync({'index.html':strToU8('<h1>Page</h1>'),'robots.txt':strToU8('User-agent: *'),'data.json':strToU8('{}'),'sitemap.xml':strToU8('<urlset/>')})));
 expect(files).toHaveLength(4);
});

test('restore reconciles monotonic remote order and refuses newer unknown releases',async()=>{
 const {reconcileRecovery}=await import('../src/recovery-reconcile.js');let raised=false;
 const pool:any={query:async(sql:string,args?:unknown[])=>{if(sql==='select id from public.sites'||sql.includes('from factory.hosting_hosts'))return {rows:[]};if(sql.startsWith('select s.site_id'))return {rows:[{site_id:'12345678-1234-1234-1234-123456789abc',domain:'fixture.example',revision_id:'rev',address:'192.0.2.1'}]};raised=true;expect(args).toEqual(['200']);return {rows:[]};}};
 const remote:any=async()=>({siteId:'12345678-1234-1234-1234-123456789abc',domain:'fixture.example',revisionId:'rev',ips:['192.0.2.1'],order:'200'});
 expect(await reconcileRecovery(pool,remote)).toEqual({checked:1,order:'200'});expect(raised).toBe(true);raised=false;
 await expect(reconcileRecovery(pool,async(...args)=>({...await remote(...args),revisionId:'newer'}))).rejects.toMatchObject({code:'CONFLICT'});expect(raised).toBe(false);
 await expect(reconcileRecovery(pool,async(...args)=>({...await remote(...args),ips:['192.0.2.1','192.0.2.2']}))).rejects.toMatchObject({code:'CONFLICT'});expect(raised).toBe(false);
});


test('256 timed-out sites are covered within the 10-minute freshness window with bounded concurrency',async()=>{
 const {createMonitoring}=await import('../src/monitoring.js');vi.useFakeTimers();
 const checked=new Set<string>(),ids=Array.from({length:256},(_,i)=>'fixture-'+i);let active=0,maximum=0;
 const query=async(sql:string,args?:any[])=>{
  if(sql.includes('pg_try_advisory_lock'))return {rows:[{ok:true}]};
  if(sql.startsWith('select s.site_id'))return {rows:ids.filter(id=>!checked.has(id)).slice(0,32).map(site_id=>({site_id}))};
  if(sql.startsWith('select b.*'))return {rows:[{site_id:args![0],domain:args![0]+'.example',ip:'192.0.2.1',revision_id:'revision'}]};
  if(sql.startsWith('insert into factory.hosting_health'))checked.add(args![0]);return {rows:[]};
 };
 const pool:any={query,connect:async()=>({query,release(){}})};
 const timeout=async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,16000));active--;throw Error('timeout');};
 const monitor=await createMonitoring(pool,{dns:timeout,health:timeout,certificate:timeout});
 try{await vi.advanceTimersByTimeAsync(540000);expect(checked.size).toBe(256);expect(maximum).toBeLessThanOrEqual(32);}
 finally{await monitor.close();vi.useRealTimers();}
});


test('Namecheap passes a compound apex suffix as TLD',async()=>{
 const {NamecheapDns}=await import('../src/namecheap.js');
 const dns=new NamecheapDns({username:'fixture',apiKey:'fixture-key',clientIp:'192.0.2.1'},async(_url,init)=>{
  const body=new URLSearchParams(String(init!.body));expect(body.get('SLD')).toBe('example');expect(body.get('TLD')).toBe('co.uk');
  return new Response('<ApiResponse Status="OK"><DomainDNSGetHostsResult Domain="example.co.uk" IsUsingOurDNS="true"/></ApiResponse>');
 },['example.co.uk']);expect((await dns.read('example.co.uk')).domain).toBe('example.co.uk');
});


test('recovery refuses to reuse addresses when Linux contains sites missing from the backup',async()=>{
 const {reconcileRecovery}=await import('../src/recovery-reconcile.js');let inspected=false;
 const pool:any={query:async(sql:string)=>({rows:sql==='select id from public.sites'?[{id:'known'}]:[{host:'192.0.2.1',port:22,username:'fixture'}]})};
 await expect(reconcileRecovery(pool,async()=>{throw Error('Do not inspect unknown content');},undefined,undefined,async()=>{inspected=true;return ['unknown'];})).rejects.toMatchObject({code:'CONFLICT'});
 expect(inspected).toBe(true);
});
