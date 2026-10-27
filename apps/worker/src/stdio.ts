import {resolve} from 'node:path';
import {createDesktopRuntime} from './desktop-runtime.js';
import {AppError} from '../../../packages/contracts/src/model.js';
import {record} from '../../../packages/contracts/src/inputs.js';
// Only the trusted Rust launch configuration supplies paths.
const root=process.env.SITE_FACTORY_DATA_ROOT, source=process.env.SITE_FACTORY_SOURCE_ROOT;
if(!root||!source)throw new Error('Trusted worker paths are required.');
const runtime=await createDesktopRuntime(resolve(root),resolve(source),{native:process.env.SITE_FACTORY_NATIVE==='1'});
let pending=Buffer.alloc(0),tail=Promise.resolve(),closing=false;
function reply(value:unknown){process.stdout.write(JSON.stringify(value)+'\n');}
process.stdin.on('data',(chunk:Buffer)=>{
 pending=Buffer.concat([pending,chunk]);
 if(pending.length>64_000){console.error('Desktop request exceeds pipe limit.');process.stdin.destroy();void close();return;}
 let end:number;
 while((end=pending.indexOf(10))>=0){
  const line=pending.subarray(0,end).toString('utf8');pending=pending.subarray(end+1);
  tail=tail.then(async()=>{let value:unknown;try{value=JSON.parse(line);
   const privateConfig=record(value)&&value.method==='model.configure'&&value.version===1&&typeof value.id==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(value.id)&&Object.keys(value).every(key=>['id','version','method','params'].includes(key));
   const privateManaged=record(value)&&typeof value.method==='string'&&value.method.startsWith('managed.')&&value.version===1&&typeof value.id==='string'&&/^[a-zA-Z0-9-]{1,64}$/.test(value.id)&&Object.keys(value).every(key=>['id','version','method','params'].includes(key));
   const result=privateConfig&&record(value)?await runtime.configure(value.params):privateManaged&&record(value)?await runtime.managed(String(value.method),value.params):await runtime.request(value);reply({id:record(value)?value.id:null,result});}
   catch(error){reply({id:record(value)&&typeof value.id==='string'?value.id:null,error:{code:error instanceof AppError?error.code:'NEEDS_ATTENTION',message:error instanceof AppError?error.message:'Исполнитель не смог выполнить операцию.'}});}});
 }
});
async function close(){if(closing)return;closing=true;await tail;await runtime.close();}
process.stdin.on('end',()=>void close());process.stdin.on('error',()=>void close());
process.on('SIGTERM',()=>{process.stdin.destroy();void close();});process.on('SIGINT',()=>{process.stdin.destroy();void close();});
