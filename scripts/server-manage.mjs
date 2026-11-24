import './lib/browser-env.mjs';
import {superviseApi} from './lib/api-supervisor.mjs';
import {rotatingLog} from './lib/rotating-log.mjs';
import {readFile,writeFile,mkdir,rm,rename,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {isIPv4} from 'node:net';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import https from 'node:https';
import {createWriteStream} from 'node:fs';
import {Console} from 'node:console';
import {Pool} from 'pg';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {migrate} from '../dist/apps/server/src/migrate.js';
import {LocalAuth,loginInput,passwordHash} from '../dist/apps/server/src/auth.js';
import {restoreWindowsBackup} from '../dist/apps/server/src/recovery.js';

const root=resolve(import.meta.dirname,'..'),base=join(root,'.local-state/server'),configPath=join(base,'config.json');
process.env.SITE_FACTORY_INSTALL_ROOT=root;
if(process.platform==='linux')process.env.SITE_FACTORY_SECRET_KEY_FILE??=join(base,'master.key');
const command=process.argv[2],args=process.argv.slice(3);
const option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
const pg=name=>join(process.env.SITE_FACTORY_PG_BIN??join(root,'.local-state/tools/pgsql/bin'),name+(process.platform==='win32'?'.exe':''));
async function run(binary,args,options={}){return new Promise((yes,no)=>{const child=spawn(binary,args,{windowsHide:true,stdio:options.input!==undefined?['pipe','inherit','inherit']:'inherit',...options});if(options.input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(options.input);}child.once('error',no);child.once('exit',code=>code===0?yes():no(Error('Command failed: '+binary)));});}
async function question(label,secret=false){if(!process.stdin.isTTY)throw Error('Use an interactive terminal or --input-json with JSON on stdin.');process.stdout.write(label+': ');const silent=new Writable({write(_chunk,_encoding,callback){callback();}}),rl=createInterface({input:process.stdin,output:secret?silent:process.stdout,terminal:true});try{return await rl.question('');}finally{rl.close();if(secret)process.stdout.write('\n');}}
let supplied={};if(args.includes('--input-json')){let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>16384)throw Error('Input too large');}supplied=JSON.parse(value);}
const input=async(name,label,secret=false)=>{if(secret&&option(name)!==undefined)throw Error('Secrets must be entered interactively or through --input-json on stdin.');return supplied[name]??(secret?undefined:option(name))??await question(label,secret);};
async function activeData(){if(process.env.SITE_FACTORY_SERVER_DATA)return resolve(process.env.SITE_FACTORY_SERVER_DATA);try{return (await readFile(join(root,'active-data.txt'),'utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;return base;}}
async function config(){return JSON.parse((await readFile(configPath,'utf8')).replace(/^\uFEFF/,''));}
async function writeConfig(value,path=configPath){const temporary=path+'.tmp-'+randomUUID();await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,path);}
async function configure(ip,data=base){
 if(!isIPv4(ip))throw Error('Specify the public IPv4 of this API server');const path=join(data,'config.json'),c=JSON.parse(await readFile(path,'utf8'));
 if(process.platform==='win32'){
  await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts/setup-native-connection.ps1'),'-PublicIPv4',ip,'-Port',String(c.tlsPort??9443),'-DataDirectory',data,'-RotateCertificate']);
 }else{
  const dir=join(data,'tls-'+randomUUID());await mkdir(dir,{mode:0o700});const pass=randomBytes(32).toString('base64url');
  try{
   await run('openssl',['req','-x509','-newkey','rsa:3072','-nodes','-days','730','-subj','/CN=Site Factory API','-addext','subjectAltName=IP:'+ip+',IP:127.0.0.1','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'});
   await run('openssl',['pkcs12','-export','-inkey',join(dir,'key.pem'),'-in',join(dir,'cert.pem'),'-out',join(dir,'cert.pfx'),'-passout','stdin'],{input:pass+'\n'});
   const certificate=await readFile(join(dir,'cert.pem'),'utf8');Object.assign(c,{publicOrigin:'https://'+ip+':'+(c.tlsPort??9443),tlsPort:c.tlsPort??9443,certificate,fingerprint:new X509Certificate(certificate).fingerprint256,tlsPfx:await protectSecret((await readFile(join(dir,'cert.pfx'))).toString('base64')),tlsPassword:await protectSecret(pass)});await writeConfig(c,path);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
 const result=JSON.parse(await readFile(path,'utf8'));await writeFile(join(root,'site-factory.sfconnection'),JSON.stringify({endpoint:result.publicOrigin,certificate:result.certificate,fingerprint:result.fingerprint},null,2));
 console.log('Connection file: '+join(root,'site-factory.sfconnection'));
}
async function connection(){const c=await config();return {host:'127.0.0.1',port:c.databasePort,user:'factory',database:c.databaseName??'factory',password:await protectSecret(c.databasePassword,true)};}
async function startDatabase(c){await run(pg('pg_ctl'),['-D',join(base,'postgres'),'-l',join(base,'postgres.log'),'-o','-h 127.0.0.1 -p '+c.port+(process.platform==='linux'?' -c unix_socket_directories=':''),'-w','start']);}
async function ensureDatabase(port){
 const running=await new Promise(yes=>{const child=spawn(pg('pg_ctl'),['-D',join(base,'postgres'),'status'],{stdio:'ignore',windowsHide:true});child.once('error',()=>yes(false));child.once('exit',code=>yes(code===0));});if(running)return;
 const service=process.platform==='win32'?(await config()).databaseService:null;
 if(!service){if(process.env.SITE_FACTORY_DATABASE_MANAGED==='1')throw Error('Managed PostgreSQL service is not running');await startDatabase({port});return;}
 if(!/^[A-Za-z0-9-]{1,80}$/.test(service))throw Error('Invalid PostgreSQL service name');
 await run('sc.exe',['start',service],{stdio:'ignore'}).catch(()=>{});
 for(let i=0;i<60;i++){try{await run(pg('pg_isready'),['-h','127.0.0.1','-p',String(port),'-q'],{stdio:'ignore'});return;}catch{}await new Promise(r=>setTimeout(r,500));}
 throw Error('PostgreSQL service is not ready: '+service);
}
async function main(){
 if(command==='init'){
  if(await stat(configPath).then(()=>true,()=>false))throw Error('Installation already exists. Use restore or address.');
  const ip=await input('ip','Public IPv4'),prepare=args.includes('--prepare'),login=prepare?'':await input('login','First user login'),password=prepare?'':await input('password','First user password (12+ characters)',true);if(!isIPv4(ip))throw Error('Invalid IPv4');
  if(!prepare){loginInput(login);if(typeof password!=='string'||password.length<12||password.length>256)throw Error('Password must contain 12–256 characters');}
  const databasePort=Number(option('database-port')??54329),tlsPort=Number(option('port')??9443);if(![databasePort,tlsPort].every(p=>Number.isInteger(p)&&p>1024&&p<65536)||databasePort===tlsPort)throw Error('Invalid ports');
  await mkdir(base,{recursive:true,mode:0o700});
  if(process.platform==='linux')await writeFile(process.env.SITE_FACTORY_SECRET_KEY_FILE,randomBytes(32),{flag:'wx',mode:0o600});
  const dbPassword=randomBytes(32).toString('base64url'),pw=join(base,'init-password');
  try{await writeFile(pw,dbPassword,{flag:'wx',mode:0o600});await run(pg('initdb'),['-D',join(base,'postgres'),'-U','factory','--auth=scram-sha-256','--encoding=UTF8','--no-locale','--pwfile='+pw]);}finally{await rm(pw,{force:true});}
  await writeConfig({databasePort,databasePassword:await protectSecret(dbPassword),tlsPort});await startDatabase({port:databasePort});
  const c=await connection(),admin=new Pool({...c,database:'postgres'});try{await admin.query('create database factory');}finally{await admin.end();}
  const pool=new Pool(c);try{await migrate(pool,root);if(!prepare){const auth=new LocalAuth(pool),session=await auth.register({login,password,invite:''},true);await auth.logout(session.token);}}finally{await pool.end();}
  await configure(ip);console.log('API initialized. Install/start the service.');
 }else if(command==='backup-target'){
  const directory=resolve(await input('directory','External backup directory')),data=await activeData();
  if(directory===resolve(data)||directory.startsWith(resolve(data)+(process.platform==='win32'?'\\':'/')))throw Error('Use a separate backup destination');
  await writeConfig({directory},join(data,'backup-replica.json'));console.log('Encrypted backup replica configured. Check replica status after the next backup.');
 }else if(command==='reset-password'){
  const data=await activeData(),c=JSON.parse(await readFile(join(data,'config.json'),'utf8'));
  const login=loginInput(await input('login','User login')),password=await input('password','New password (12+ characters)',true),hash=await passwordHash(password);
  const pool=new Pool({host:'127.0.0.1',port:c.databasePort,user:'factory',database:c.databaseName??'factory',password:await protectSecret(c.databasePassword,true)});
  try{await pool.query('begin');const result=await pool.query('update factory.accounts set password_hash=$2 where login=$1 returning id',[login,hash]);if(!result.rowCount)throw Error('User not found');const id=result.rows[0].id;await pool.query('delete from factory.sessions where user_id=$1',[id]);await pool.query("insert into factory.audit(actor,action) values($1,'account.password.operator-reset')",[id]);await pool.query('commit');console.log('Password changed; all user sessions revoked.');}catch(e){await pool.query('rollback');throw e;}finally{await pool.end();}
 }else if(command==='address'){await configure(await input('ip','Public IPv4'),option('data')?resolve(option('data')):await activeData());console.log('Restart API and import the new connection file in each client.');
 }else if(command==='restore'){
  const archive=resolve(await input('backup','Backup file')),password=await input('key','Recovery key',true),ip=await input('ip','New public IPv4');if(!isIPv4(ip))throw Error('Invalid IPv4');
  const destination=resolve(option('destination')??join(root,'restored-'+Date.now())),database='sf_restore_'+randomBytes(8).toString('hex');
  const db=await connection();await ensureDatabase(db.port);
  const result=await restoreWindowsBackup({root,archive,password,destination,database,connection:db});
  await configure(ip,join(destination,'data'));const pointer=join(root,'active-data.txt'),temporary=pointer+'.'+randomUUID();await writeFile(temporary,join(destination,'data'),{mode:0o600});await rename(temporary,pointer);
  console.log('Restored with workers paused: '+result.destination+'\nRestart service; review SSH access and DNS provider IP restrictions before resuming.');
 }else if(command==='status'){
  const c=JSON.parse(await readFile(join(await activeData(),'config.json'),'utf8')),origin=new URL(c.publicOrigin);
  await new Promise((yes,no)=>{const req=https.request({hostname:'127.0.0.1',port:c.tlsPort,path:'/auth/status',ca:c.certificate,headers:{host:origin.host,origin:origin.origin}},res=>{let bytes='';res.on('data',chunk=>{bytes+=chunk;if(bytes.length>16384)res.destroy();});res.on('error',no);res.on('end',()=>{try{const body=JSON.parse(bytes);if(res.statusCode!==200||!Object.hasOwn(body,'user')||body.bootstrap!==false)throw Error('API is not ready');yes();}catch(e){no(e);}});});req.setTimeout(3000,()=>req.destroy(Error('API check timed out')));req.on('error',no);req.end();});console.log('API ready: '+origin.origin);
 }else if(command==='serve'||command==='run-api'){
  const data=await activeData();
  if(command==='serve'){if(args.includes('--log')){const log=rotatingLog(join(data,'supervisor.log'));globalThis.console=new Console(log,log);}await superviseApi(root,data);return;}
  if(args.includes('--log')){const log=rotatingLog(join(data,'server.log'));globalThis.console=new Console(log,log);process.on('uncaughtExceptionMonitor',()=>console.error(new Date().toISOString(),'api.uncaught_exception'));}
  const c=JSON.parse(await readFile(join(data,'config.json'),'utf8'));
  // The dedicated database cluster belongs to this installation, including after restore.
  await ensureDatabase(c.databasePort);
  process.env.SITE_FACTORY_SERVER_DATA=data;process.env.SITE_FACTORY_SOURCE_ROOT=c.sourceRoot??root;
  await import(pathToFileURL(join(root,'dist/apps/server/src/main.js')).href);
 }else throw Error('Usage: server-manage.mjs init|restore|address|serve|status|reset-password|backup-target [--input-json]');
}
main().catch(error=>{console.error('Operation failed: '+error.message);process.exitCode=1;});
