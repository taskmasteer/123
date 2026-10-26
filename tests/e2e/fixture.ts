import {test as base,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline';
export {expect};
type Bridge={failNext:(method:string,message:string)=>void;polls:()=>number;requests:{method:string;params:Record<string,unknown>}[]};
export const test=base.extend<{workerBridge:Bridge}>({
 workerBridge:[async({page},use)=>{
  const data=await mkdtemp(join(tmpdir(),'site-factory-e2e-'));
  const worker=spawn(process.execPath,[resolve('dist/apps/worker/src/stdio.js')],{stdio:['pipe','pipe','pipe'],env:{...process.env,SITE_FACTORY_DATA_ROOT:data,SITE_FACTORY_SOURCE_ROOT:resolve('.')}});
  const pending=new Map<string,{resolve:(v:unknown)=>void;reject:(e:unknown)=>void}>();
  const failures=new Map<string,string>();const requests:Bridge['requests']=[];let polls=0;
  const lines=createInterface({input:worker.stdout});
  lines.on('line',line=>{const response=JSON.parse(line);const handler=pending.get(response.id);pending.delete(response.id);if(response.error)handler?.reject(response.error);else handler?.resolve(response.result);});
  worker.stderr.on('data',chunk=>process.stderr.write(chunk));
  const dispatch=(request:{id:string})=>new Promise((resolve,reject)=>{pending.set(request.id,{resolve,reject});worker.stdin.write(JSON.stringify(request)+'\n');});
  // This test-only browser binding exercises the real private-pipe worker, not Rust/WebView2 ACL.
  await page.exposeBinding('__desktopTestDispatch',async(_source,request)=>{requests.push(request);const failure=failures.get(request.method);if(failure){failures.delete(request.method);throw new Error(failure);}const result=await dispatch(request);if(request.method==='site.list')polls++;return result;});
  await page.addInitScript(()=>{Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{invoke:(_command:string,args:{request:unknown})=>(window as unknown as {__desktopTestDispatch:(request:unknown)=>Promise<unknown>}).__desktopTestDispatch(args.request)}});});
  try{await use({failNext:(method,message)=>failures.set(method,message),polls:()=>polls,requests});}finally{
   worker.stdin.end();await new Promise<void>(resolve=>{if(worker.exitCode!==null)return resolve();worker.once('exit',()=>resolve());});
   lines.close();await rm(data,{recursive:true,force:true});
  }
 },{auto:true}],
});
