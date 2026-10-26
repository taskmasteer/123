import {it,expect,afterEach} from 'vitest';
import {resolve} from 'node:path';
import {createDesktopRuntime} from '../src/desktop-runtime.js';
import {directory,cleanDirectories} from './fixtures.js';
afterEach(cleanDirectories);
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
 expect(await request('device.status')).toMatchObject({usage:{inputTokens:9,outputTokens:4}});
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
