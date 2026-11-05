import './lib/browser-env.mjs';
// Billable real-model test. Isolated registry; no hosting addresses, DNS keys or publication intents.
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {migrate} from '../dist/apps/server/src/migrate.js';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {createServerRuntime} from '../dist/apps/server/src/runtime.js';
const root=resolve(import.meta.dirname,'..');
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const resume=arg('--resume'),selected=arg('--references')?.split(',');
const id=resume??'sf_reference_'+randomUUID().replaceAll('-','');
if(!/^sf_reference_[a-f0-9]{32}$/.test(id))throw Error('Invalid isolated run identifier');
const data=resolve(root,'.local-state',id);await mkdir(data,{recursive:true});
const cfg=JSON.parse((await readFile(resolve(root,'.local-state/server/config.json'),'utf8')).replace(/^\uFEFF/,''));
const connection={host:'127.0.0.1',port:cfg.databasePort,user:'factory',password:await protectSecret(cfg.databasePassword,true)};
const admin=new Pool({...connection,database:'postgres'});if(!resume)await admin.query('create database '+id);await admin.end();
const pool=new Pool({...connection,database:id,max:12});let runtime;
const report=resume?JSON.parse(await readFile(resolve(data,'report.json'),'utf8')):{run:id,startedAt:new Date().toISOString(),realModel:true,published:false,results:[]};
if(resume){report.previousResults=[...(report.previousResults??[]),...report.results.filter(r=>!selected||selected.includes(r.reference.slice(10)))];report.results=report.results.filter(r=>selected&&!selected.includes(r.reference.slice(10)));delete report.finishedAt;delete report.passed;report.resumedAt=new Date().toISOString();}
const save=async()=>writeFile(resolve(data,'report.json'),JSON.stringify(report,null,2));
try{
 await migrate(pool,root);
 if(!resume){const source=new Pool({...connection,database:'factory'});try{const encrypted=(await source.query("select value from factory.settings where key='deepseek'")).rows[0]?.value;if(!encrypted)throw Error('DeepSeek is not configured');await pool.query("insert into factory.settings values('deepseek',$1)",[encrypted]);}finally{await source.end();}}
 if((await pool.query('select 1 from factory.hosting_hosts union all select 1 from factory.hosting_addresses union all select 1 from factory.auto_publications')).rowCount)throw Error('Test database must have no hosting infrastructure');
 runtime=await createServerRuntime(pool,root,data,'http://127.0.0.1:4314');
 let account=(await pool.query('select id from factory.accounts limit 1')).rows[0];
 if(!account){await runtime.auth.register({login:'matrix_test',password:randomBytes(32).toString('base64url'),invite:''},true);account=(await pool.query('select id from factory.accounts limit 1')).rows[0];}
 const actor={userId:account.id,role:'admin'};
 const catalog=JSON.parse(await readFile(resolve(root,'templates/catalog.json'),'utf8'));
 const templates=await Promise.all(catalog.filter(t=>t.enabled&&t.id.startsWith('reference-')&&(!selected||selected.includes(t.id.slice(10)))).map(async t=>({...t,bytes:(await Promise.all(t.files.map(f=>stat(resolve(root,'templates',t.id,f))))).reduce((n,s)=>n+s.size,0)})));
 templates.sort((a,b)=>b.bytes-a.bytes);
 if(!templates.length||selected?.some(ref=>!templates.some(t=>t.id==='reference-'+ref)))throw Error('Unknown or disabled reference selection');
 await save();
 const active=new Map();let next=0,lastLog=0;
 console.log(JSON.stringify({run:id,references:templates.map(t=>({id:t.id,bytes:t.bytes})),report:resolve(data,'report.json')}));
 while(next<templates.length||active.size){
  while(active.size<2&&next<templates.length){
   const template=templates[next++],ref=template.id.slice(10);
   const site=await runtime.repository.create({domain:ref+'-'+randomUUID().slice(0,8)+'.example',about:'An English concept site explaining domain-anchored identity and verifiable digital credentials. Adapt all template text to this topic. Keep the supplied layout and use concise informative content. Do not invent clients, testimonials or achievements.',referenceId:'corporate',layoutReferenceId:ref,mentionedUrl:'https://www.example.com/guide',mentionedDescription:'An illustrative resource link supplied for this test. Describe it as an example guide, without claims about its real contents.'},actor);
   active.set(site.id,{template,started:Date.now(),maxReplayBytes:0,turns:0,outputRepairs:0});
  }
  const progress=[];
  for(const [siteId,item] of active){
   const job=(await pool.query('select data from private.jobs where site_id=$1',[siteId])).rows[0]?.data;
   let checkpoint;if(job?.checkpointId)checkpoint=await runtime.store.load(job.checkpointId);
   const state=checkpoint?.state,c=state?.continuation;
   item.maxReplayBytes=Math.max(item.maxReplayBytes,c?JSON.stringify(c).length:0);item.turns=Math.max(item.turns,c?.turns??0);item.outputRepairs=Math.max(item.outputRepairs,c?.outputRepairs??0);
   progress.push({reference:item.template.id,state:job?.state,stage:job?.stage,turns:item.turns,seconds:Math.round((Date.now()-item.started)/1000)});
   if(!['completed','needs_attention','cancelled'].includes(job?.state)&&Date.now()-item.started<20*60*1000)continue;
   if(!['completed','needs_attention','cancelled'].includes(job?.state))await runtime.queue.cancel(siteId,actor);
   const current=await runtime.repository.get(siteId);let files=checkpoint?.files??[];
   if(current.draftId){const revision=await runtime.repository.revision(current.draftId);files=await runtime.store.read(revision.manifestId);}
   const html=files.filter(f=>f.mediaType==='text/html').map(f=>Buffer.from(f.bytes).toString()).join('\n');
   const placeholders=(html.match(/\bContent \d+\b/g)??[]).length,link=html.includes(current.input.mentionedUrl);
   const result={reference:item.template.id,sourceBytes:item.template.bytes,siteId,checkpointId:job?.checkpointId,state:job?.state,stage:job?.stage,passed:job?.state==='completed'&&!!current.draftId&&!current.publishedId&&!!html&&placeholders===0&&link,seconds:Math.round((Date.now()-item.started)/1000),turns:item.turns,outputRepairs:item.outputRepairs,maxReplayBytes:item.maxReplayBytes,placeholders,mentionedLink:link,error:state?.error??null,usage:state?.transcript,files:files.map(f=>({path:f.path,bytes:f.bytes.length})),selection:state?.selection};
   const out=resolve(data,item.template.id+'-'+siteId);await mkdir(out,{recursive:true});
   for(const file of files){const path=resolve(out,file.path);if(!path.startsWith(out+sep))throw Error('Invalid artifact path');await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,file.bytes);}
   report.results.push(result);await save();console.log(JSON.stringify({finished:result.reference,passed:result.passed,error:result.error,seconds:result.seconds,turns:result.turns,placeholders}));active.delete(siteId);
  }
  if(Date.now()-lastLog>30000){lastLog=Date.now();console.log(JSON.stringify({completed:report.results.length,total:templates.length,active:progress}));}
  await new Promise(r=>setTimeout(r,3000));
 }
 report.finishedAt=new Date().toISOString();report.passed=report.results.every(r=>r.passed);
 if((await pool.query('select 1 from factory.hosting_jobs union all select 1 from factory.auto_publications')).rowCount)throw Error('Unexpected publication activity');
 await save();console.log(JSON.stringify({finished:true,passed:report.passed,report:resolve(data,'report.json')}));if(!report.passed)process.exitCode=1;
}finally{await runtime?.close();await pool.end();}
