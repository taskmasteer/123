import { test, expect } from 'vitest';
import { createManagedRuntime } from '../src/managed-runtime.js';
import type { WorkerDeps } from '../src/pipeline.js';
test('explicit visual-only mode starts enrolled remote polling without model configuration and never asks for AI jobs',async()=>{
 const calls:{path:string;body:unknown}[]=[];const runtime=createManagedRuntime(()=>({} as WorkerDeps),()=>false,(async(url,init)=>{calls.push({path:new URL(String(url)).pathname,body:JSON.parse(String(init?.body))});return Response.json(String(url).endsWith('/health/claim')?{claim:null,nextWakeAt:Date.now()+21600000}:String(url).endsWith('/claim')?null:{});}) as typeof fetch);
 const p=await runtime.request('managed.prepare',{}) as {workerId:string;token:string};await runtime.request('managed.start',{...p,controlOrigin:'https://control.test',mode:'visual'});await expect.poll(()=>calls.filter(c=>c.path.endsWith('/claim')).length).toBeGreaterThan(0);await runtime.stop();expect(calls.filter(c=>c.path.endsWith('/jobs/claim')).every(c=>JSON.stringify(c.body)==='{"mode":"visual"}')).toBe(true);expect(calls.some(c=>c.path==='/worker/health/claim'&&JSON.stringify(c.body)==='{}')).toBe(true);
});
test('private enrollment generates an unpredictable token and sends only to configured HTTPS without redirects', async () => {
    const sent: RequestInit[] = [];
    const runtime = createManagedRuntime(() => ({} as WorkerDeps), () => false, (async (url, init) => {
        expect(String(url)).toBe('https://control.test/workers/enroll');
        sent.push(init!);
        const body = JSON.parse(String(init?.body));
        return Response.json({ workerId: body.workerId, name: body.name });
    }) as typeof fetch);
    const a = await runtime.request('managed.prepare', {}) as any, b = await runtime.request('managed.prepare', {}) as any;
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
    const result = await runtime.request('managed.enroll', { ...a, name: 'Machine', controlOrigin: 'https://control.test', accessToken: 'transient-admin' });
    expect(JSON.stringify(result)).not.toContain(a.token);
    expect(sent[0]!.redirect).toBe('error');
    expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer transient-admin' });
    await expect(runtime.request('managed.enroll', { ...a, name: 'Machine', controlOrigin: 'http://control.test', accessToken: 'transient-admin' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runtime.request('managed.start', { ...a, controlOrigin: 'https://control.test' })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await runtime.stop();
});

for(const phase of ['prepare','put','complete'])test('managed stop converges during pending upload '+phase,async()=>{
 let claimed=false,entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);let lease:any;const id='11111111-1111-4111-8111-111111111111';
 const runtime=createManagedRuntime(()=>({clock:{now:Date.now},workspace:'.local-state/test-stop',templates:{load:async()=>[]},model:{run:async()=>({summary:'done',inputTokens:0,outputTokens:0})}} as unknown as WorkerDeps),()=>true,async(url,init)=>{
  const path=new URL(String(url)).pathname,body=init?.body&&init.method!=='PUT'?JSON.parse(String(init.body)):{};
  const current=path==='/uploads/prepare'?'prepare':init?.method==='PUT'?'put':path==='/uploads/complete'?'complete':null;
  if(current===phase){entered();return new Promise<Response>(()=>{});}
  if(path==='/uploads/prepare'){const files=[...body.files,...(body.state?[body.state]:[])];return Response.json({uploadId:id,expiresAt:Date.now()+600000,files:files.map((f:any)=>({path:f.path,objectKey:'immutable/'+f.path,url:'https://fixture.r2.cloudflarestorage.com/'+f.path,headers:{'content-type':f.mediaType,'if-none-match':'*'}}))});}
  if(init?.method==='PUT')return new Response(null,{status:200});
  if(path.endsWith('/jobs/claim')){if(claimed)return Response.json(null);claimed=true;lease={jobId:id,workerId:body.workerId??workerId,generation:1,expiresAt:Date.now()+120000};return Response.json({job:{id,siteId:id,kind:'generate',stage:'brief',state:'running',checkpointId:null,baseRevision:0,generation:{seed:2,styleId:'editorial',templateVersion:'1.0.0'}},lease});}
  if(path.endsWith('/health/claim'))return Response.json({claim:null,nextWakeAt:Date.now()+21600000});
  if(path.endsWith('/publication-receipt'))return Response.json(null);
  if(path.endsWith('/heartbeat'))return Response.json(lease);
  if(path.endsWith('/site'))return Response.json({id,domain:'stop.test',ownerId:id,assignedUserIds:[],input:{domain:'stop.test',about:'A provided event tracing concept'},revision:0,draftId:null,publishedId:null,generationStatus:'queued',domainStatus:'pending'});
  return Response.json({ok:true});
 });
 const prepared=await runtime.request('managed.prepare',{}) as {workerId:string;token:string},workerId=prepared.workerId;
 await runtime.request('managed.start',{...prepared,controlOrigin:'https://control.test'});await waiting;
 expect(await Promise.race([runtime.stop().then(()=> 'stopped'),new Promise<string>(r=>setTimeout(()=>r('stuck'),250))])).toBe('stopped');
});
