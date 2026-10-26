import {it,expect,afterEach} from 'vitest';
import {resolve} from 'node:path';
import {createDesktopRuntime} from '../src/desktop-runtime.js';
import {directory,cleanDirectories} from './fixtures.js';
afterEach(cleanDirectories);
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
