import * as editingModule from '../../../packages/core/src/editing.js';
import { existingLocalDatabase } from '../../../packages/adapters/src/local-database.js';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';import {it,expect,afterEach} from 'vitest';
import {resolve} from 'node:path';
import {createDesktopRuntime} from '../src/desktop-runtime.js';
import {directory,cleanDirectories} from './fixtures.js';
afterEach(cleanDirectories);
it.each(['auth','quota','model'])('explicit Retry recovers %s for the same generation after correction',async(failure)=>{
 const bodies:any[]=[];const headers:string[]=[];
 const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Saved research notes</title><style>body{font:20px sans-serif;margin:24px;color:#111;background:#fff}</style></head><body><h1>Manual research notes</h1><p>Preserve this completed content when account settings are corrected.</p></body></html>';
 const transport=(async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);headers.push(new Headers(init?.headers).get('authorization')!);
  if(bodies.length===1)return Response.json({status:'completed',output:[{type:'function_call',call_id:'saved-write',name:'write',arguments:JSON.stringify({path:'index.html',text:html})}],usage:{input_tokens:10,output_tokens:5}});
  if(bodies.length===2)return Response.json({error:{code:failure==='quota'?'insufficient_quota':failure==='auth'?'invalid_api_key':'model_not_found'}},{status:failure==='quota'?429:failure==='auth'?401:404});
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Saved content preserved.'}]}],usage:{input_tokens:2,output_tokens:1}});
 }) as typeof fetch;
 const runtime=await createDesktopRuntime(await directory(),resolve('.'),{native:true,transport});const request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:'recover',version:1,method,params});
 try{
  await runtime.configure({mode:'live',apiKey:'old-key',model:'configured'});const created=await request('site.create',{domain:failure+'-recovery.test',about:'A supplied research concept for preserved event notes'});
  await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state).toBe('needs_attention');expect(bodies).toHaveLength(2);
  if(failure!=='quota')await runtime.configure({mode:'live',apiKey:'corrected-key',model:failure==='model'?'replacement':'configured'});expect(bodies).toHaveLength(2);
  await request('job.retry',{siteId:created.site.id});await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state,{timeout:20000}).toBe('completed');
  expect(bodies).toHaveLength(3);expect(headers[2]).toBe(failure==='quota'?'Bearer old-key':'Bearer corrected-key');expect(bodies[2].input.some((item:any)=>item.call_id==='saved-write')).toBe(failure!=='model');
  await expect.poll(async()=>(await request('device.status')).usage).toEqual({inputTokens:12,outputTokens:6});
  expect((await request('site.list')).items[0].publishedId).toBeTruthy();
 }finally{await runtime.close();}
},30000);
it.each(['rotate','delete'])('%s during a live tool loop aborts old calls before the next request',async(action)=>{
 const headers:string[]=[];let waiting=false;
 const transport=(async(_url,init)=>{
  const auth=new Headers(init?.headers).get('authorization')!;headers.push(auth);
  if(headers.length===1)return Response.json({status:'completed',output:[{type:'function_call',call_id:'inspect',name:'list',arguments:'{}'}]});
  if(auth==='Bearer old-synthetic-key'){waiting=true;return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Existing text preserved.'}]}],usage:{input_tokens:3,output_tokens:2}});
 }) as typeof fetch;
 const runtime=await createDesktopRuntime(await directory(),resolve('.'),{transport});
 const request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:'mid-loop',version:1,method,params});
 try{
  const created=await request('site.create',{domain:action+'.test'});await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state,{timeout:20000}).toBe('completed');
  const site=(await request('site.list')).items[0];await runtime.configure({mode:'live',apiKey:'old-synthetic-key',model:'configured'});
  await request('edit.request',{siteId:site.id,expectedRevision:site.revision,instruction:'Preserve existing text'});await expect.poll(()=>waiting).toBe(true);
  await runtime.configure(action==='rotate'?{mode:'live',apiKey:'new-synthetic-key',model:'configured'}:{mode:'blocked'});
  if(action==='rotate'){
   await expect.poll(async()=>(await request('job.status',{siteId:site.id})).state,{timeout:20000}).toBe('completed');expect(headers).toEqual(['Bearer old-synthetic-key','Bearer old-synthetic-key','Bearer new-synthetic-key']);
   const chat=await request('chat.list',{siteId:site.id});expect(JSON.stringify(chat)).not.toContain('encrypted_content');expect(JSON.stringify(chat)).not.toContain('synthetic-key');
  }else{expect((await request('job.status',{siteId:site.id})).state).toBe('paused');expect(headers).toHaveLength(2);expect(await request('device.status')).toMatchObject({mode:'blocked',activeJobs:0});}
 }finally{await runtime.close();}
},30000);
it('reports returned token usage even when a live response refuses the job',async()=>{
 const transport=(async()=>Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'Cannot comply'}]}],usage:{input_tokens:9,output_tokens:4}})) as typeof fetch;
 const runtime=await createDesktopRuntime(await directory(),resolve('.'),{native:true,transport});
 const request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:'usage',version:1,method,params});
 try{await runtime.configure({mode:'live',apiKey:'fixture-secret',model:'configured'});const created=await request('site.create',{domain:'usage.test'});
 await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state).toBe('needs_attention');
 // Terminal job persistence precedes async edit recovery and checkpoint usage publication.
 await expect.poll(()=>request('device.status')).toMatchObject({usage:{inputTokens:9,outputTokens:4}});
 }finally{await runtime.close();}
});
it('native boot waits for private configuration, rotates calls and never falls back from a live error',async()=>{
 const root=await directory();let calls=0;const secrets:string[]=[];
 const transport=(async(_url,init)=>{calls++;secrets.push(new Headers(init?.headers).get('authorization')!);return Response.json({error:{code:'invalid_api_key',message:'synthetic-key'}},{status:401});}) as typeof fetch;
 const runtime=await createDesktopRuntime(root,resolve('.'),{native:true,transport});
 const request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:'test',version:1,method,params});
 try{
 expect(await request('device.status')).toMatchObject({mode:'blocked',available:false});
 await expect(request('model.configure',{mode:'live',apiKey:'synthetic-key',model:'configured'})).rejects.toMatchObject({code:'INVALID_INPUT'});
 await expect(runtime.configure({mode:'live',apiKey:'synthetic-key',model:'configured',path:'bad'})).rejects.toMatchObject({code:'INVALID_INPUT'});
 const configured=await runtime.configure({mode:'live',apiKey:'synthetic-key',model:'configured'});expect(JSON.stringify(configured)).not.toContain('synthetic-key');
 expect(await request('device.status')).toMatchObject({mode:'live',model:'configured',images:'disabled',storage:'local',publication:'demo'});
 const created=await request('site.create',{domain:'live-error.test'});
 await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state).toBe('needs_attention');expect(calls).toBe(1);
 expect((await request('site.list')).items[0].publishedId).toBeNull();
 await runtime.configure({mode:'blocked'});expect(await request('device.status')).toMatchObject({mode:'blocked',available:false});
 await expect(request('site.create',{domain:'blocked.test'})).rejects.toMatchObject({code:'NEEDS_ATTENTION'});expect(calls).toBe(1);
 await runtime.configure({mode:'live',apiKey:'rotated-key',model:'configured'});await request('site.create',{domain:'rotated.test'});
 await expect.poll(()=>calls).toBe(2);expect(secrets).toEqual(['Bearer synthetic-key','Bearer rotated-key']);
 }finally{await runtime.close();}
});
it('persists generated revision, rejects foreign screenshot access and persists catalog changes',async()=>{
 const root=await directory(); let runtime=await createDesktopRuntime(root,resolve('.'));
 const request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:'test',version:1,method,params});
 try{
 const created=await request('site.create',{domain:'example.test',about:'Reliable data systems'});
 expect(created).toMatchObject({site:{domain:'example.test'},job:{state:'queued'}});
 await expect.poll(async()=> (await request('job.status',{siteId:created.site.id})).state,{timeout:20000}).toBe('completed');
 const list=await request('site.list'); const site=list.items[0]; expect(site.publishedId).toBeTruthy();
 const snapshot=await request('preview.screenshot',{siteId:site.id,revisionId:site.publishedId,width:375}); expect(snapshot.dataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
 expect(await request('preview.open',{siteId:site.id,revisionId:site.publishedId})).toEqual({opened:true});
 await expect(request('preview.screenshot',{siteId:'00000000-0000-4000-8000-000000000000',revisionId:site.publishedId,width:375})).rejects.toMatchObject({code:'NOT_FOUND'});
 await request('catalog.style.update',{id:'dark-tech',enabled:false});
 await runtime.close(); runtime=await createDesktopRuntime(root,resolve('.'));
 expect((await request('site.list')).items[0].publishedId).toBe(site.publishedId);
 expect((await request('catalog.list')).styles.find((s:any)=>s.id==='dark-tech').enabled).toBe(false);
 expect((await request('preview.screenshot',{siteId:site.id,revisionId:site.publishedId,width:1440})).dataUrl).toMatch(/^data:image\/png;base64,/);
 }finally{await runtime.close();}
},30000);


it('resumes an interrupted generation after closing and reopening the controller',async()=>{
 const root=await directory();let runtime=await createDesktopRuntime(root,resolve('.'));
 const request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:'restart',version:1,method,params});
 try{
  const created=await request('site.create',{domain:'restart.test'});
  await runtime.close();
  runtime=await createDesktopRuntime(root,resolve('.'));
  await expect.poll(async()=> (await request('job.status',{siteId:created.site.id})).state,{timeout:20000}).toBe('completed');
  expect((await request('site.list')).items[0].publishedId).toBeTruthy();
 }finally{await runtime.close();}
},30000);
it.each(['edit.accept', 'site.publish'])('drains the actual delayed%s promise before snapshot or close', async (method) => {
    const original = editingModule.createEditing;
    let entered!: () => void, release!: () => void;
    const called = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
    let database: Awaited<ReturnType<typeof existingLocalDatabase>>;
    const spy = vi.spyOn(editingModule, 'createEditing').mockImplementation(deps => ({ ...original(deps), [method === 'edit.accept' ? 'acceptCandidate' : 'publish']: async () => { entered(); await hold; database!.transaction(() => database!.sql.prepare('insert into metadata values(?,?)').run('delayed-' + method, 'settled')); return {}; } }));
    const root = await directory(), runtime = await createDesktopRuntime(root, resolve('.'), { native: true }), request = (name: string, params: unknown = {}) => runtime.request({ id: 'delayed', version: 1, method: name, params });
    database = await existingLocalDatabase(root);
    let captureEntered = false, captureRelease!: () => void;
    const captureHold = new Promise<void>(r => captureRelease = r), snapshot = database!.snapshot.bind(database);
    database!.snapshot = async (target) => { captureEntered = true; await captureHold; return snapshot(target); };
    let requestWork: Promise<unknown> | undefined;
    try {
        requestWork = request(method, { siteId: randomUUID(), ...(method === 'edit.accept' ? { candidateId: randomUUID() } : {}), expectedRevision: 0 });
        await called;
        const operation = await runtime.archive({ action: 'backup', passphrase: 'delayed operation test' }) as {
            id: string;
        };
        await expect.poll(async () => { try {
            await request('device.status');
            return false;
        }
        catch (e: any) {
            return e.code === 'CONFLICT';
        } }).toBe(true);
        expect(captureEntered).toBe(false);
        release();
        await requestWork;
        await expect.poll(() => captureEntered).toBe(true);
        captureRelease();
        await expect.poll(async () => (await runtime.archive({ action: 'status', id: operation.id }) as any).state, { timeout: 15000 }).toBe('ready');
        expect(database!.sql.prepare('select value from metadata where key=?').get('delayed-' + method)?.value).toBe('settled');
    }
    finally {
        release();
        captureRelease();
        await requestWork?.catch(() => { });
        await runtime.close();
        spy.mockRestore();
    }
}, 30000);
it.each(['edit.accept', 'site.publish'])('does not close persistence before delayed%s settles', async (method) => {
    const original = editingModule.createEditing;
    let entered!: () => void, release!: () => void;
    const called = new Promise<void>(r => entered = r), hold = new Promise<void>(r => release = r);
    let database: Awaited<ReturnType<typeof existingLocalDatabase>>;
    const spy = vi.spyOn(editingModule, 'createEditing').mockImplementation(deps => ({ ...original(deps), [method === 'edit.accept' ? 'acceptCandidate' : 'publish']: async () => { entered(); await hold; database!.sql.prepare('insert into metadata values(?,?)').run('close-' + method, 'settled'); return {}; } }));
    const root = await directory(), runtime = await createDesktopRuntime(root, resolve('.'), { native: true });
    database = await existingLocalDatabase(root);
    let closeEntered = false;
    const closeDatabase = database!.close.bind(database);
    database!.close = async () => { closeEntered = true; await closeDatabase(); };
    let closing: Promise<void> | undefined, work: Promise<unknown> | undefined;
    try {
        work = runtime.request({ id: 'close', version: 1, method, params: { siteId: randomUUID(), ...(method === 'edit.accept' ? { candidateId: randomUUID() } : {}), expectedRevision: 0 } });
        await called;
        closing = runtime.close();
        await new Promise(setImmediate);
        expect(closeEntered).toBe(false);
        release();
        await work;
        await closing;
        expect(closeEntered).toBe(true);
    }
    finally {
        release();
        await work?.catch(() => { });
        await closing;
        await runtime.close();
        spy.mockRestore();
    }
});

it('contextual running edit cancellation aborts the local model and preserves published content',async()=>{
 let entered=false,aborted=false;const runtime=await createDesktopRuntime(await directory(),resolve('.'),{transport:async(_url,init)=>{entered=true;return new Promise<Response>((_,reject)=>init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled synthetic transport'));},{once:true}));}}),request=(method:string,params:unknown={}):Promise<any>=>runtime.request({id:randomUUID(),version:1,method,params});
 try{const created=await request('site.create',{domain:'cancel-active.test',about:'A supplied concept for preserving published event notes'});await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state,{timeout:20000}).toBe('completed');const before=(await request('site.list')).items[0];await expect(request('job.cancel',{siteId:before.id})).rejects.toMatchObject({code:'CONFLICT'});
 await runtime.configure({mode:'live',apiKey:'synthetic',model:'configured'});await request('edit.request',{siteId:before.id,expectedRevision:before.revision,instruction:'Refine current text'});await expect.poll(()=>entered).toBe(true);await request('job.cancel',{siteId:before.id});await expect.poll(()=>aborted).toBe(true);expect((await request('job.status',{siteId:before.id})).state).toBe('cancelled');expect((await request('site.list')).items[0]).toMatchObject({publishedId:before.publishedId,draftId:before.draftId,revision:before.revision});
 }finally{await runtime.close();}
},30000);
