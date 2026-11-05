import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv,scrypt as scryptCallback} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile,readdir,stat,mkdir,rm,open,rename,lstat} from 'node:fs/promises';
import {join,resolve,relative,sep,dirname} from 'node:path';
import {Pool,type PoolConfig} from 'pg';
import {portableArchive} from '../../../packages/adapters/src/backup-archive.js';
import {privateDirectory,safeFile} from '../../../packages/adapters/src/safe-files.js';
import type {BackupEntry} from '../../../packages/core/src/backup.js';
import {AppError} from '../../../packages/contracts/src/model.js';
import {protectSecret} from './secrets.js';

const format='site-factory-windows-v1',chunkBytes=4*1024*1024;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export type SecretCodec=(value:string,decrypt?:boolean)=>Promise<string>;
async function keyFor(password:string,salt:Buffer){return new Promise<Buffer>((yes,no)=>scryptCallback(password,salt,32,{N:131072,r:8,p:1,maxmem:256*1024*1024},(e,k)=>e?no(e):yes(k)));}
async function wrap(value:unknown,password:string){const salt=randomBytes(16),iv=randomBytes(12),key=await keyFor(password,salt);try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(format));return Buffer.concat([salt,iv,cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString('base64');}finally{key.fill(0);}}
async function unwrap(value:string,password:string){const bytes=Buffer.from(value,'base64');if(bytes.length<44)throw Error('Invalid secret bundle');const key=await keyFor(password,bytes.subarray(0,16));try{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(16,28));cipher.setAAD(Buffer.from(format));cipher.setAuthTag(bytes.subarray(-16));return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28,-16)),cipher.final()]).toString());}finally{key.fill(0);}}
export async function removePrivateTree(root:string,target:string){const base=resolve(root).replace(/[\\/]$/,'')+sep,path=resolve(target);if(!path.startsWith(base))throw Error('Unsafe cleanup target');await rm(path,{recursive:true,force:true});}
async function pgTool(root:string,name:'pg_dump'|'pg_restore',connection:PoolConfig,args:string[]){
  const binary=process.env.SITE_FACTORY_PG_BIN?join(process.env.SITE_FACTORY_PG_BIN,name+(process.platform==='win32'?'.exe':'')):process.platform==='win32'?join(process.env.SITE_FACTORY_INSTALL_ROOT??root,'.local-state/tools/pgsql/bin',name+'.exe'):name;
  await new Promise<void>((yes,no)=>{
    const child=spawn(binary,['-h',String(connection.host??'127.0.0.1'),'-p',String(connection.port??54329),'-U',String(connection.user??'factory'),...args],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,PGPASSWORD:String(connection.password??'')}});
    const timer=setTimeout(()=>{child.kill();no(Error(name+' timed out'));},1800000);
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);no(Error(name+' unavailable'));});child.on('close',code=>{clearTimeout(timer);code===0?yes():no(Error(name+' failed'));});
  });
}
async function restrictRestoredDirectory(path:string){
  if(process.platform!=='win32')return;
  await new Promise<void>((yes,no)=>{
    const child=spawn('icacls.exe',[path,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,stdio:'ignore'});
    child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Cannot protect restored data')));
  });
}
async function* walk(root:string,path=''):AsyncGenerator<string>{
  const base=join(root,path);let entries;try{entries=await readdir(base,{withFileTypes:true});}catch(e){if(absent(e))return;throw e;}
  for(const entry of entries){const name=path?path+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw Error('Backup cannot include reparse points');if(entry.isDirectory())yield*walk(root,name);else if(entry.isFile())yield name;else throw Error('Non-regular backup member');}
}
type Bundle={settings:{key:string;value:string}[];hosts:{id:string;credential:string;bootstrap:string|null;operation:Record<string,unknown>|null}[];config:Record<string,unknown>;legacy:{path:string;value:Record<string,unknown>}[]};
async function transformFields(value:Record<string,unknown>,codec:SecretCodec,decrypt:boolean){const result={...value};for(const key of ['databasePassword','tlsPfx','tlsPassword','privateKeyEncrypted','nextCredential'])if(typeof result[key]==='string')result[key]=await codec(result[key] as string,decrypt);return result;}
export async function captureWindowsBackup(options:{pool:Pool;root:string;data:string;connection:PoolConfig;password:string;codec?:SecretCodec}){
  const {pool,root,data,connection,password}=options,codec=options.codec??protectSecret;
  if(Buffer.byteLength(password)<16||Buffer.byteLength(password)>1024)throw new AppError('INVALID_INPUT','Ключ копии должен занимать 16–1024 байта.');
  const directory=await privateDirectory(join(data,'recovery')),stage=await privateDirectory(join(directory,'work-'+randomUUID()));
  try{
    const config=JSON.parse((await readFile(join(data,'config.json'),'utf8')).replace(/^\uFEFF/,''));
    const bundle:Bundle={settings:[],hosts:[],config:await transformFields(config,codec,true),legacy:[]};
    for(const row of (await pool.query('select key,value from factory.settings')).rows)bundle.settings.push({key:row.key,value:await codec(row.value,true)});
    for(const row of (await pool.query('select id,credential,bootstrap,operation from factory.hosting_hosts')).rows)bundle.hosts.push({...row,credential:await codec(row.credential,true),bootstrap:row.bootstrap?await codec(row.bootstrap,true):null,operation:row.operation?await transformFields(row.operation,codec,true):null});
    for await(const path of walk(join(data,'ssh'))){
      if(!path.endsWith('.json'))continue;
      const bytes=await readFile(join(data,'ssh',path));
      const value=JSON.parse(bytes.toString(bytes[0]===255&&bytes[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,''));
      // This legacy directory also contains diagnostic reports and scripts.
      // Only connection configurations carry portable credentials.
      if(typeof value.privateKeyEncrypted==='string')bundle.legacy.push({path,value:await transformFields(value,codec,true)});
    }
    // Secrets are separately encrypted before entering the archive's temporary
    // ZIP, so no plaintext API/SSH/TLS key is written to a staging file.
    const encryptedSecrets=await wrap(bundle,password);
    const dump=join(stage,'database.dump');await pgTool(root,'pg_dump',connection,['-Fc','--no-owner','--no-acl','-f',dump,String(connection.database??'factory')]);
    async function* entries():AsyncGenerator<BackupEntry>{
      let ordinal=0;
      const record=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value));return {name:'records/'+ordinal+++'.json',size:bytes.length,sha256:hash(bytes),read:async()=>bytes};};
      yield record({format,createdAt:new Date().toISOString(),encryptedSecrets});
      async function* file(kind:string,path:string,filePath:string):AsyncGenerator<BackupEntry>{
        const size=(await stat(filePath)).size,handle=await open(filePath,'r');
        try{for(let offset=0;offset<size||offset===0;offset+=chunkBytes){const bytes=Buffer.alloc(Math.min(chunkBytes,size-offset));if((await handle.read(bytes,0,bytes.length,offset)).bytesRead!==bytes.length)throw Error('Backup file changed');const payload='payloads/'+ordinal+'.bin';yield record({type:'windows-part',kind,path,offset,total:size,payload});yield {name:payload,size:bytes.length,sha256:hash(bytes),read:async()=>bytes};}}finally{await handle.close();}
      }
      yield*file('database','database.dump',dump);
      for(const folder of ['objects','validation','attempts'])for await(const path of walk(join(data,folder))){if(path.includes('.pending-'))continue;yield*file('data',folder+'/'+path,join(data,folder,path));}
      try{yield*file('data','catalog-overrides.json',join(data,'catalog-overrides.json'));}catch(e){if(!absent(e))throw e;}
      for(const folder of ['templates','references','dist','scripts','supabase/migrations'])for await(const path of walk(join(root,folder)))yield*file('source',folder+'/'+path,join(root,folder,path));
      for(const path of ['package.json','package-lock.json'])yield*file('source',path,join(root,path));
      for(const family of ['apps','packages'])for(const name of await readdir(join(root,family)))try{yield*file('source',family+'/'+name+'/package.json',join(root,family,name,'package.json'));}catch(e){if(!absent(e)&&!(e as NodeJS.ErrnoException).code?.includes('ENOTDIR'))throw e;}
    }
    const archive=portableArchive(directory),file=await archive.create(password,entries());
    // Authenticate the produced archive before advertising it as restorable.
    const verified=await archive.verify(file,password);await removePrivateTree(directory,verified.directory);
    return {file,bytes:(await stat(file)).size};
  }finally{await removePrivateTree(directory,stage);}
}

/** Restore only to a new database and an absent destination. Never overwrites a
 * running installation. External jobs remain held until explicitly resumed. */
export async function restoreWindowsBackup(options:{archive:string;password:string;destination:string;database:string;connection:PoolConfig;root:string;codec?:SecretCodec}){
  const {archive,password,database,connection,root}=options,codec=options.codec??protectSecret,destination=resolve(options.destination);
  if(!/^sf_restore_[a-z0-9_]{1,48}$/.test(database))throw new AppError('INVALID_INPUT','Используйте имя новой базы sf_restore_…');
  try{await lstat(destination);throw new AppError('CONFLICT','Каталог восстановления уже существует.');}catch(e){if(!absent(e))throw e;}
  const parent=await privateDirectory(dirname(destination)),stage=await privateDirectory(join(parent,'.restore-'+randomUUID()));
  const admin=new Pool({...connection,database:'postgres'});let created=false,installed=false;
  try{
    // Windows ignores POSIX mode bits: lock this newly created staging tree
    // before extracting the database or re-encrypting LocalMachine secrets.
    await restrictRestoredDirectory(stage);
    if((await admin.query('select 1 from pg_database where datname=$1',[database])).rowCount)throw new AppError('CONFLICT','База восстановления уже существует.');
    const verified=await portableArchive(stage).verify(archive,password);
    try{
      const iterator=verified.entries[Symbol.iterator](),first=iterator.next();if(first.done||first.value.name!=='records/0.json')throw Error('Missing recovery metadata');
      const metadata=JSON.parse(await readFile(first.value.file,'utf8'));if(metadata.format!==format)throw Error('Unsupported recovery format');
      const bundle=await unwrap(metadata.encryptedSecrets,password) as Bundle;
      const completed=new Set<string>();let active='',offset=0,total=0,output:Awaited<ReturnType<typeof open>>|null=null;
      try{for(let item=iterator.next();!item.done;item=iterator.next()){
        const part=JSON.parse(await readFile(item.value.file,'utf8')),payload=iterator.next();
        if(part.type!=='windows-part'||!['database','data','source'].includes(part.kind)||typeof part.path!=='string'||payload.done||payload.value.name!==part.payload||!Number.isSafeInteger(part.total)||part.total<0)throw Error('Invalid recovery part');
        if(!/^[a-zA-Z0-9_. /-]+$/.test(part.path)||part.path.split('/').some((s:string)=>!s||s==='.'||s==='..')||part.path.includes('\\')||part.path.startsWith('/'))throw Error('Unsafe recovery path');
        if(part.kind==='database'&&part.path!=='database.dump'||part.kind==='data'&&!/^(objects\/|validation\/|attempts\/|catalog-overrides\.json$)/.test(part.path))throw Error('Unexpected recovery member');
        const identity=part.kind+'/'+part.path;
        if(identity!==active){if(output&&offset!==total)throw Error('Truncated recovery member');await output?.close();output=null;if(completed.has(identity)||part.offset!==0)throw Error('Duplicate recovery member');completed.add(identity);active=identity;offset=0;total=part.total;const base=await privateDirectory(join(stage,part.kind));output=await open(await safeFile(base,part.path,true),'wx',0o600);}
        if(part.offset!==offset||part.total!==total||payload.value.size!==Math.min(chunkBytes,total-offset))throw Error('Invalid recovery offset');
        await output!.writeFile(await readFile(payload.value.file));offset+=payload.value.size;
      }if(offset!==total)throw Error('Truncated recovery member');}finally{await output?.close();}
      if(!completed.has('database/database.dump')||!completed.has('source/package-lock.json'))throw Error('Incomplete installation backup');
      await admin.query(`do $$begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin;end if;end$$`);
      await admin.query('create database '+database);created=true;
      await pgTool(root,'pg_restore',connection,['--no-owner','--no-acl','--exit-on-error','--single-transaction','-d',database,join(stage,'database/database.dump')]);
      const target=new Pool({...connection,database});
      try{
        await target.query('begin');
        for(const setting of bundle.settings)await target.query('update factory.settings set value=$2 where key=$1',[setting.key,await codec(setting.value)]);
        for(const host of bundle.hosts)await target.query('update factory.hosting_hosts set credential=$2,bootstrap=$3,operation=$4 where id=$1',[host.id,await codec(host.credential),host.bootstrap?await codec(host.bootstrap):null,host.operation?await transformFields(host.operation,codec,false):null]);
        await target.query(`delete from factory.sessions;update factory.invites set used_at=now() where used_at is null;update private.workers set revoked_at=now();
          insert into factory.system_state values('recovery_hold','true') on conflict(key) do update set value='true';
          update factory.hosting_jobs set status='failed',error='Восстановлено из копии. Проверьте сервер и DNS перед повтором.' where status in ('queued','running','waiting');
          update factory.hosting_hosts set status='failed',error='Восстановлено из копии. Проверьте SSH перед повтором.' where status in ('queued','running');
          update factory.backups set status='unavailable',path=null;`);
        await target.query('commit');
      }finally{await target.end();}
      const data=await privateDirectory(join(stage,'data'));
      const config=await transformFields({...bundle.config,databasePassword:String(connection.password),databasePort:connection.port,databaseName:database,sourceRoot:join(destination,'source')},codec,false);
      await writeFile(join(data,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
      for(const legacy of bundle.legacy){const base=await privateDirectory(join(data,'ssh'));await writeFile(await safeFile(base,legacy.path,true),JSON.stringify(await transformFields(legacy.value,codec,false)),{mode:0o600});}
    }finally{await removePrivateTree(stage,verified.directory);}
    await removePrivateTree(stage,join(stage,'database'));
    await rename(stage,destination);installed=true;return {database,destination,held:true};
  }finally{
    if(!installed){if(created)await admin.query('drop database '+database+' with (force)');await removePrivateTree(parent,stage);}
    await admin.end();
  }
}

export async function createRecovery(pool:Pool,root:string,data:string,exclusive:<T>(action:()=>Promise<T>)=>Promise<T>){
  let running:Promise<void>|null=null,closed=false,admitted=false;
  const automated=await stat(join(data,'config.json')).then(()=>true,()=>false);
  await pool.query("update factory.backups set status='failed',error='Копирование прервано перезапуском.' where status='running'");
  async function key(){const row=(await pool.query("select value from factory.settings where key='backup_passphrase'")).rows[0];if(row)return protectSecret(row.value,true);const password=randomBytes(32).toString('base64url');await pool.query("insert into factory.settings values('backup_passphrase',$1) on conflict do nothing",[await protectSecret(password)]);return protectSecret((await pool.query("select value from factory.settings where key='backup_passphrase'")).rows[0].value,true);}
  async function create(){
    if(admitted||closed)throw new AppError('CONFLICT','Резервная копия уже создаётся.');
    admitted=true;const id=randomUUID();try{await pool.query("insert into factory.backups(id,status) values($1,'running')",[id]);}catch(e){admitted=false;throw e;}
    running=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
      try{const password=await key(),config=JSON.parse(await readFile(join(data,'config.json'),'utf8'));
        const result=await exclusive(async()=>captureWindowsBackup({pool,root,data,password,connection:{host:'127.0.0.1',port:config.databasePort,user:'factory',database:config.databaseName??'factory',password:await protectSecret(config.databasePassword,true)}}));
        await pool.query("update factory.backups set status='complete',path=$2,bytes=$3,completed_at=now() where id=$1",[id,result.file,result.bytes]);
        const expired=(await pool.query("select id,path from factory.backups where status='complete' and (download_until is null or download_until<now()) and id not in(select id from factory.backups where status='complete' order by completed_at desc limit 7)")).rows;
        for(const old of expired)if(old.path&&resolve(old.path).startsWith(resolve(data,'recovery')+sep)){try{await rm(old.path,{force:true});await pool.query("update factory.backups set status='expired',path=null where id=$1",[old.id]);}catch{console.error('Не удалось удалить старую резервную копию; новая копия сохранена.');}}
      }catch{await pool.query("update factory.backups set status='failed',error='Копия не создана. Проверьте свободное место и доступ к PostgreSQL; рабочие данные сохранены.' where id=$1",[id]);}
    }).finally(()=>{running=null;admitted=false;});return {id};
  }
  const list=async()=>(await pool.query('select id,status,error,bytes,created_at,completed_at from factory.backups order by created_at desc limit 30')).rows;
  const timer=setInterval(()=>{if(automated&&!admitted&&!closed)void pool.query("select 1 from factory.backups where status='complete' and completed_at>now()-interval '24 hours' or status in ('failed','running') and created_at>now()-interval '1 hour'").then(r=>{if(!r.rowCount)return create();}).catch(()=>{});},60000);timer.unref();
  return {create,key,list,async file(id:string){const row=(await pool.query("update factory.backups set download_until=now()+interval '10 minutes' where id=$1 and status='complete' returning path,bytes",[id])).rows[0];if(!row||!resolve(row.path).startsWith(resolve(data,'recovery')+sep))throw new AppError('NOT_FOUND','Копия не найдена.');return row;},async close(){closed=true;clearInterval(timer);await running;}};
}
