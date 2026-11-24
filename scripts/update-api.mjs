// Offline update. Service wrappers stop/start API; PostgreSQL stays running.
import {readFile,writeFile,mkdir,open,rm,stat,readdir,lstat,unlink,symlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {verifyApiArchive} from './lib/api-release.mjs';
import {installRelease,rollbackRelease} from './lib/api-upgrade.mjs';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {captureWindowsBackup} from '../dist/apps/server/src/recovery.js';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),base=join(root,'.local-state/server');
const exists=path=>stat(path).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const run=(binary,params,env=process.env)=>new Promise((yes,no)=>{const p=spawn(binary,params,{cwd:root,env,stdio:'inherit',windowsHide:true});p.once('error',no);p.once('exit',code=>code===0?yes():no(Error('Upgrade preparation failed')));});
if(process.platform==='linux')process.env.SITE_FACTORY_SECRET_KEY_FILE??=join(base,'master.key');
process.env.SITE_FACTORY_INSTALL_ROOT=root;
let data=base;try{data=(await readFile(join(root,'active-data.txt'),'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;}
const config=JSON.parse(await readFile(join(data,'config.json'),'utf8'));
const online=await new Promise(yes=>{const socket=createConnection({host:'127.0.0.1',port:config.tlsPort});socket.once('connect',()=>{socket.destroy();yes(true);});socket.once('error',()=>yes(false));socket.setTimeout(2000,()=>{socket.destroy();yes(true);});});
if(online)throw Error('Stop the API service before updating; keep PostgreSQL running.');
if(await exists(join(root,'.git')))throw Error('Use Git/build tooling for a development checkout; the updater is for installed API packages.');
const lockPath=join(base,'upgrade.lock');let lock;
try{lock=await open(lockPath,'wx',0o600);}catch(e){
 if(e.code!=='EEXIST')throw e;
 const prior=Number(await readFile(lockPath,'utf8'));if(!Number.isSafeInteger(prior)||prior<1)throw Error('Invalid upgrade lock; inspect it locally');
 try{process.kill(prior,0);throw Error('Another updater is running');}catch(e){if(e.code!=='ESRCH')throw e;}
 await rm(lockPath);lock=await open(lockPath,'wx',0o600);
}
await lock.writeFile(String(process.pid));
try{
 const journalPath=join(root,'.local-state/upgrade.json');
 if(await exists(journalPath)&&(JSON.parse(await readFile(journalPath,'utf8'))).state==='installing')await rollbackRelease(root);
 if(args[0]==='rollback'){
  const pool=new Pool({host:'127.0.0.1',port:config.databasePort,user:'factory',database:config.databaseName??'factory',password:await protectSecret(config.databasePassword,true)});
  try{const count=Number((await pool.query("select (select count(*) from private.jobs where data->>'state' in ('queued','running','waiting_provider'))+(select count(*) from factory.hosting_jobs where status in ('queued','running','waiting')) n")).rows[0].n);if(count)throw Error('Drain active jobs before rolling back');}finally{await pool.end();}
  await rollbackRelease(root);console.log('Previous API code restored. Restart and verify health.');
 }
 else{
  if(args.length!==1)throw Error('Usage: node scripts/update-api.mjs ARCHIVE | rollback');
  const archive=resolve(args[0]),manifest=await verifyApiArchive(archive,await readFile(join(root,'apps/client/release-key.pem')));
  const current=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8')).version;
  // These migrations are additive. A future schema change requires an explicit compatibility policy.
  if(manifest.version!=='0.6.0'||!['0.5.0','0.6.0'].includes(current)||manifest.target!==(process.platform==='win32'?'windows':'linux'))throw Error('Unsupported upgrade or platform; use a validated backup/restore migration.');
  const prepared=join(root,'.local-state/upgrades','prepared-'+randomUUID());await mkdir(prepared,{recursive:true});
  await run('tar',['-xf',archive,'-C',prepared]);
  const metadata=JSON.parse(await readFile(join(prepared,'api-package.json'),'utf8'));
  if(metadata.version!==manifest.version||metadata.postgresMajor!==18)throw Error('Package compatibility mismatch');
  const npmCandidates=[process.env.SITE_FACTORY_NPM_CLI,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),join(root,'.local-state/tools/npm/package/bin/npm-cli.js')];
  let npm;for(const path of npmCandidates)if(path&&await exists(path)){npm=path;break;}if(!npm)throw Error('Bundled npm not found');
  await run(process.execPath,[npm,'ci','--prefix',prepared,'--omit=dev','--ignore-scripts'],{...process.env,ELECTRON_SKIP_BINARY_DOWNLOAD:'1'});
  await run(process.execPath,[join(prepared,'scripts/check-api-browser.mjs')],{...process.env,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH??join(root,'.local-state/browsers')});
  const pool=new Pool({host:'127.0.0.1',port:config.databasePort,user:'factory',database:config.databaseName??'factory',password:await protectSecret(config.databasePassword,true)});
  try{
   const count=Number((await pool.query("select (select count(*) from private.jobs where data->>'state' in ('queued','running','waiting_provider'))+(select count(*) from factory.hosting_jobs where status in ('queued','running','waiting'))+(select count(*) from factory.hosting_hosts where status in ('queued','running')) n")).rows[0].n);
   if(count)throw Error('Drain active jobs before upgrading');
   let password=(await pool.query("select value from factory.settings where key='backup_passphrase'")).rows[0]?.value;
   if(password)password=await protectSecret(password,true);else{password=randomBytes(32).toString('base64url');await pool.query("insert into factory.settings values('backup_passphrase',$1)",[await protectSecret(password)]);}
   const backup=await captureWindowsBackup({root,data,pool,password,connection:{host:'127.0.0.1',port:config.databasePort,user:'factory',database:config.databaseName??'factory',password:await protectSecret(config.databasePassword,true)}});
   await pool.query("insert into factory.backups(id,status,path,bytes,completed_at) values($1,'complete',$2,$3,now())",[randomUUID(),backup.file,backup.bytes]);
  }finally{await pool.end();}
  await installRelease(root,prepared,async name=>{
   if(name!=='node_modules')return;
   // npm uses absolute workspace junctions on Windows. Rebind them after moving.
   for(const family of ['apps','packages'])for(const entry of await readdir(join(root,family))){
    const folder=join(root,family,entry),pkg=join(folder,'package.json');if(!await exists(pkg))continue;
    const name=JSON.parse(await readFile(pkg,'utf8')).name;if(!/^@site-factory\/[a-z0-9-]+$/.test(name))continue;
    const link=join(root,'node_modules',name);try{if(!(await lstat(link)).isSymbolicLink())continue;await unlink(link);}catch(e){if(e.code!=='ENOENT')throw e;}
    await mkdir(dirname(link),{recursive:true});await symlink(folder,link,process.platform==='win32'?'junction':'dir');
   }
  });
  console.log('Signed API release installed; previous code and encrypted backup retained. Restart and verify health.');
 }
}finally{await lock.close();await rm(lockPath,{force:true});}
