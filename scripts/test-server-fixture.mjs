import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {createServer} from 'node:net';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
const root=resolve('.local-state'),dir=join(root,'server-ci-'+randomBytes(8).toString('hex'));
await mkdir(dir,{recursive:true,mode:0o700});
const bin=process.env.SITE_FACTORY_PG_BIN??(process.platform==='win32'?resolve('.local-state/tools/pgsql/bin'):'/usr/lib/postgresql/18/bin');
function run(name,args){const result=spawnSync(join(bin,name+(process.platform==='win32'?'.exe':'')),args,{stdio:'ignore',windowsHide:true});if(result.status!==0)throw Error(name+' failed in isolated fixture');}
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
let started=false;
try{
 if(process.platform==='linux'){process.env.SITE_FACTORY_SECRET_KEY_FILE=join(dir,'master.key');await writeFile(process.env.SITE_FACTORY_SECRET_KEY_FILE,randomBytes(32),{mode:0o600});}
 const password=randomBytes(32).toString('base64url'),pw=join(dir,'password'),config=join(dir,'config.json');await writeFile(pw,password,{mode:0o600});
 run('initdb',['-D',join(dir,'postgres'),'-U','factory','--auth=scram-sha-256','--pwfile='+pw,'--encoding=UTF8','--no-locale']);
 run('pg_ctl',['-D',join(dir,'postgres'),'-l',join(dir,'postgres.log'),'-o','-h 127.0.0.1 -p '+port+(process.platform==='linux'?' -c unix_socket_directories=':''),'-w','start']);started=true;
 await writeFile(config,JSON.stringify({databasePort:port,databasePassword:await protectSecret(password)}),{mode:0o600});
 const result=spawnSync(process.execPath,['scripts/test-server.mjs'],{stdio:'inherit',windowsHide:true,env:{...process.env,SITE_FACTORY_TEST_CONFIG:config,SITE_FACTORY_PG_BIN:bin}});process.exitCode=result.status??1;
}finally{
 if(started)run('pg_ctl',['-D',join(dir,'postgres'),'-m','fast','-w','stop']);
 const target=await realpath(dir),base=await realpath(root);if(!target.startsWith(base+sep))throw Error('Unsafe fixture cleanup');await rm(target,{recursive:true,force:true});
}
