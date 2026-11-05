// Isolated real CLI installation/restore. Does not use the production DB or DNS.
import {mkdir,cp,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import https from 'node:https';
import {Pool} from 'pg';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {captureWindowsBackup} from '../dist/apps/server/src/recovery.js';
const root=resolve(import.meta.dirname,'..'),stage=join(root,'.local-state/api-install-smoke-'+randomUUID());
await mkdir(stage,{recursive:true});
for(const file of ['dist','scripts','templates','references','supabase/migrations','package.json','package-lock.json'])await cp(join(root,file),join(stage,file),{recursive:true});
for(const family of ['apps','packages'])for(const name of await readdir(join(root,family))){try{await mkdir(join(stage,family,name),{recursive:true});await cp(join(root,family,name,'package.json'),join(stage,family,name,'package.json'));}catch(e){if(e.code!=='ENOENT')throw e;}}
const pgBin=process.env.SITE_FACTORY_PG_BIN??join(root,'.local-state/tools/pgsql/bin'),env={...process.env,SITE_FACTORY_PG_BIN:pgBin,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH??join(root,'.local-state/browsers')};
if(process.platform==='linux')env.SITE_FACTORY_SECRET_KEY_FILE=join(stage,'.local-state/server/master.key');
const cli=join(stage,'scripts/server-manage.mjs'),login='portable_owner',password='fixture-only-'+randomUUID(),recoveryKey='fixture-only-'+randomUUID();
let server,output='';
async function run(binary,args,input){return new Promise((yes,no)=>{const child=spawn(binary,args,{cwd:stage,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let text='';child.stdout.on('data',c=>text+=c);child.stderr.on('data',c=>text+=c);child.once('error',no);child.once('exit',code=>code===0?yes(text):no(Error(text)));child.stdin.on('error',()=>{});child.stdin.end(input??'');});}
async function request(profile,path,body){return new Promise((yes,no)=>{const req=https.request(profile.endpoint+path,{ca:profile.certificate,method:body?'POST':'GET',headers:{origin:profile.endpoint,'content-type':'application/json'}},res=>{let bytes='';res.on('data',c=>bytes+=c);res.on('end',()=>yes({status:res.statusCode,body:JSON.parse(bytes)}));});req.on('error',no);req.setTimeout(2000,()=>req.destroy());req.end(body?JSON.stringify(body):undefined);});}
async function start(){const profile=JSON.parse(await readFile(join(stage,'site-factory.sfconnection'),'utf8'));server=spawn(process.execPath,[cli,'serve'],{cwd:stage,env,windowsHide:true,stdio:['ignore','pipe','pipe']});server.stdout.on('data',c=>output+=c);server.stderr.on('data',c=>output+=c);for(let i=0;i<80;i++){try{const status=await request(profile,'/auth/status');assert.equal(status.status,200);assert.equal(status.body.user,null);assert.equal(status.body.bootstrap,false);assert.equal((await request(profile,'/api/sites')).status,401);assert.equal((await request(profile,'/auth/login',{login,password})).status,200);return;}catch{}if(server.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,250));}throw Error('API startup failed: '+output);}
async function stop(){if(!server)return;const current=server;server=null;const exited=new Promise(r=>current.once('exit',r));current.kill();await exited;}
try{
 await run(process.execPath,[cli,'init','--ip','127.0.0.1','--port','19443','--database-port','54339','--input-json'],JSON.stringify({login,password}));
 console.log('Fresh installation initialized');await start();await stop();console.log('HTTPS, login and authentication required: passed');
 if(process.platform==='linux')process.env.SITE_FACTORY_SECRET_KEY_FILE=env.SITE_FACTORY_SECRET_KEY_FILE;
 process.env.SITE_FACTORY_PG_BIN=pgBin;
 const data=join(stage,'.local-state/server'),c=JSON.parse(await readFile(join(data,'config.json'),'utf8')),connection={host:'127.0.0.1',port:54339,user:'factory',database:'factory',password:await protectSecret(c.databasePassword,true)},pool=new Pool(connection);
 let backup;try{await mkdir(join(data,'objects'),{recursive:true});await writeFile(join(data,'objects','portable.txt'),'portable fixture');backup=await captureWindowsBackup({root:stage,data,pool,connection,password:recoveryKey});}finally{await pool.end();}
 await writeFile(join(stage,'fixture-recovery.json'),JSON.stringify({archive:backup.file,key:recoveryKey,login,password}),{mode:0o600});
 await run(process.execPath,[cli,'restore','--ip','127.0.0.1','--backup',backup.file,'--input-json'],JSON.stringify({key:recoveryKey}));
 await start();await stop();const restored=(await readFile(join(stage,'active-data.txt'),'utf8')).trim(),rc=JSON.parse(await readFile(join(restored,'config.json'),'utf8'));
 const target=new Pool({...connection,database:rc.databaseName});try{assert.equal((await target.query("select value from factory.system_state where key='recovery_hold'")).rows[0].value,true);}finally{await target.end();}
 assert.equal(await readFile(join(restored,'objects/portable.txt'),'utf8'),'portable fixture');
 const old=JSON.parse(await readFile(join(stage,'site-factory.sfconnection'),'utf8'));await run(process.execPath,[cli,'address','--ip','127.0.0.1']);assert.notEqual(JSON.parse(await readFile(join(stage,'site-factory.sfconnection'),'utf8')).fingerprint,old.fingerprint);await start();await stop();
 console.log('CLI restore, preserved account/files, held workers, address rotation and restart: passed');
 console.log('Evidence: '+stage);
}finally{await stop();await run(join(pgBin,'pg_ctl'+(process.platform==='win32'?'.exe':'')),['-D',join(stage,'.local-state/server/postgres'),'-m','fast','-w','stop']).catch(()=>{});}
