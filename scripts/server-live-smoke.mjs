import './lib/browser-env.mjs';
// Optional, billable integration check. Uses the encrypted key already configured locally.
// Creates a disposable local database and never publishes or modifies DNS.
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {migrate} from '../dist/apps/server/src/migrate.js';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {createServerRuntime} from '../dist/apps/server/src/runtime.js';
const root=resolve(import.meta.dirname,'..'),id='sf_live_'+randomUUID().replaceAll('-',''),data=resolve(root,'.local-state',id),origin='http://127.0.0.1:4314';
const config=JSON.parse((await readFile(resolve(root,'.local-state/server/config.json'),'utf8')).replace(/^\uFEFF/,''));
const connection={host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true)};
const source=new Pool({...connection,database:'factory'}),encrypted=(await source.query("select value from factory.settings where key='deepseek'")).rows[0]?.value;await source.end();
if(!encrypted)throw new Error('Configure DeepSeek first.');
const admin=new Pool({...connection,database:'postgres'});await admin.query('create database '+id);const pool=new Pool({...connection,database:id,max:10});
let runtime;
try{
 await mkdir(data,{recursive:true});await migrate(pool,root);await pool.query("insert into factory.settings values('deepseek',$1)",[encrypted]);
 runtime=await createServerRuntime(pool,root,data,origin);
 const session=await runtime.auth.register({login:'live_test',password:randomBytes(24).toString('base64url'),invite:''},true);
 const site=await runtime.repository.create({domain:'live-preview.example',about:'A small English concept landing page for a documentation studio named Clear Notes. One HTML page, minimal CSS, no JavaScript needed. Keep content concise. No invented team, clients or metrics.',referenceId:'corporate',...(process.env.SITE_FACTORY_TEST_REFERENCE?{layoutReferenceId:process.env.SITE_FACTORY_TEST_REFERENCE}:{}),mentionedUrl:'https://www.example.com/guide',mentionedDescription:'This is an illustrative resource URL supplied for a local generation test. Describe it explicitly as an example reference, not as a real documentation service. Encourage exploring the example link without claiming any specific content.'},await runtime.auth.verifyUser(session.token));
 console.log('Live DeepSeek generation started in isolated local database.');
 const deadline=Date.now()+480000;let last='';
 while(Date.now()<deadline){
  const job=(await pool.query('select data from private.jobs where site_id=$1',[site.id])).rows[0]?.data;
  const status=job?.state+':'+job?.stage;if(last!==status){last=status;console.log(status);}
  if(job?.state==='completed'){
   const current=await runtime.repository.get(site.id);if(!current.draftId||current.publishedId)throw new Error('Unexpected publication state.');
   if(process.env.SITE_FACTORY_TEST_REFERENCE&&(await runtime.store.load(job.checkpointId)).state.selection?.styleId!=='reference-'+process.env.SITE_FACTORY_TEST_REFERENCE)throw Error('Wrong layout template');
   const revision=await runtime.repository.revision(current.draftId),files=await runtime.store.read(revision.manifestId);
   await writeFile(resolve(data,'result.json'),JSON.stringify({passed:true,liveModel:true,model:'deepseek-flash',domain:current.domain,published:false,files:files.map(f=>f.path),checkedDraft:current.draftId},null,2));console.log('Live generation passed. Evidence: '+data);break;
  }
  if(['needs_attention','waiting_provider','paused'].includes(job?.state)){const checkpoint=await runtime.store.load(job.checkpointId);console.log(JSON.stringify({error:checkpoint.state.error,validation:checkpoint.state.validation}));throw new Error('Live generation needs attention.');}
  await new Promise(r=>setTimeout(r,1500));
 }
 if(!last.startsWith('completed:'))throw new Error('Live generation timeout.');
}finally{await runtime?.close();await pool.end();await admin.query('drop database '+id);await admin.end();}
