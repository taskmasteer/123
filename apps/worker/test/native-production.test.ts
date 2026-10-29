import {it,expect,afterEach,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {resolve,join} from 'node:path';
import {readdir} from 'node:fs/promises';
import {directory,cleanDirectories} from './fixtures.js';
import {createDesktopRuntime} from '../src/desktop-runtime.js';
import {waitForNativeStart} from '../src/bootstrap.js';
import {activeLocalRoot} from '../src/local-root.js';
import {openLocalDatabase,existingLocalDatabase} from '../../../packages/adapters/src/local-database.js';
import {createLocalEditingStore} from '../../../packages/adapters/src/local-state.js';
afterEach(async()=>{vi.unstubAllEnvs();await cleanDirectories();});
async function permit(){const stream=new PassThrough(),pending=waitForNativeStart(stream,true);stream.write('SF_NATIVE_START_V1\n');const result=await pending;stream.destroy();return result!;}
it('production local defaults, caller/env flags and serialized permits cannot authorize native persistence',async()=>{
 const root=await directory();vi.stubEnv('NODE_ENV','production');vi.stubEnv('SITE_FACTORY_NATIVE','1');vi.stubEnv('SITE_FACTORY_NATIVE_PRIVATE','1');
 await expect(openLocalDatabase(root)).rejects.toMatchObject({code:'FORBIDDEN'});
 await expect((openLocalDatabase as (...args:unknown[])=>Promise<unknown>)(root,{usage:'native-private'})).rejects.toMatchObject({code:'FORBIDDEN'});
 await expect(createDesktopRuntime(root,resolve('.'),{native:true})).rejects.toMatchObject({code:'FORBIDDEN'});
 await expect(createDesktopRuntime(root,resolve('.'),{native:true,nativePersistencePermit:JSON.parse(JSON.stringify(await permit()))})).rejects.toMatchObject({code:'FORBIDDEN'});
});
it('an ordinary handle injected after environment changes cannot authorize production editing',async()=>{
 const root=await directory(),ordinary=await openLocalDatabase(root);vi.stubEnv('NODE_ENV','production');
 try{await expect(createLocalEditingStore(root,ordinary)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(createLocalEditingStore(root,{...ordinary,nativePrivate:true} as typeof ordinary)).rejects.toMatchObject({code:'FORBIDDEN'});}finally{await ordinary.close();}
});
it('verified private bootstrap permits production state and independent restore without serializing authority',async()=>{
 const root=await directory(),nativePermit=await permit();vi.stubEnv('NODE_ENV','production');
 const runtime=await createDesktopRuntime(root,resolve('.'),{native:true,nativePersistencePermit:nativePermit});
 const complete=async(id:string)=>{let value:any;await expect.poll(async()=>{value=await runtime.archive({action:'status',id});return value.state;},{timeout:15000}).toMatch(/^(ready|failed)$/);if(value.state==='failed')throw Error(value.error);return value.result;};
 try{
  expect(await runtime.request({id:'production',version:1,method:'device.status',params:{}})).toMatchObject({mode:'blocked'});
  await createLocalEditingStore(root,(await existingLocalDatabase(root))!);
  const request=(method:string,params:Record<string,unknown>={}):Promise<any>=>runtime.request({id:'production-edit',version:1,method,params});
  await runtime.configure({mode:'demo'});
  const created=await request('site.create',{domain:'production-native.test'});
  await expect.poll(async()=>(await request('job.status',{siteId:created.site.id})).state,{timeout:20000}).toBe('completed');
  const site=(await request('site.list')).items[0];
  await request('edit.request',{siteId:site.id,expectedRevision:site.revision,instruction:'Production private edit'});
  let candidates:any;await expect.poll(async()=>{candidates=await request('edit.list',{siteId:site.id});return candidates.candidates.at(-1)?.status;},{timeout:20000}).toBe('ready');
  await request('edit.accept',{siteId:site.id,candidateId:candidates.candidates.at(-1).id,expectedRevision:site.revision});
  const edited=(await request('site.list')).items[0];expect(edited.draftId).toBeTruthy();
  const backup=await runtime.archive({action:'backup',passphrase:'synthetic production restore password'}) as {id:string};await complete(backup.id);
  const archive=(await readdir(join(root,'.exports'))).find(name=>name.endsWith('.sfbak'))!;
  const inspect=await runtime.archive({action:'inspect',archivePath:join(root,'.exports',archive),passphrase:'synthetic production restore password'}) as {id:string};await complete(inspect.id);
  const restore=await runtime.archive({action:'restore',id:inspect.id,mappings:[]}) as {id:string};expect(await complete(restore.id)).toMatchObject({restoredSites:1,restartRequired:true,quarantined:true});
  const selected=await activeLocalRoot(root,resolve('.'));const restarted=await createDesktopRuntime(selected.root,selected.sourceRoot,{native:true,nativePersistencePermit:nativePermit,baseRoot:root});
  try{expect(await restarted.request({id:'restored',version:1,method:'recovery.status',params:{}})).toMatchObject({quarantined:true});expect((await restarted.request({id:'restored-list',version:1,method:'site.list',params:{}}) as any).items[0].draftId).toBe(edited.draftId);}finally{await restarted.close();}
 }finally{await runtime.close();}
},30000);
