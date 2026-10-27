// Dedicated disposable PostgreSQL only. Never inspect or reuse host services.
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
const root=resolve('.local-state'); mkdirSync(root,{recursive:true});
const dir=join(root,'pg-test-'+randomBytes(8).toString('hex')); mkdirSync(dir);
const data=join(dir,'data'), password=randomBytes(32).toString('hex'), pw=join(dir,'password');
const bin=process.env.SITE_FACTORY_PG_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
function run(name,args,env=process.env){const r=spawnSync(join(bin,name+'.exe'),args,{env,stdio:'ignore',windowsHide:true}); if(r.status!==0)throw new Error(name+' failed (see dedicated test log).');}
const socket=createServer(); await new Promise(r=>socket.listen(0,'127.0.0.1',r)); const port=socket.address().port; await new Promise(r=>socket.close(r));
let started=false;
try {
 writeFileSync(pw,password,{mode:0o600});
 run('initdb',['-D',data,'-U','test_admin','--auth=scram-sha-256','--pwfile='+pw,'--encoding=UTF8','--no-locale']);
 run('pg_ctl',['-D',data,'-l',join(dir,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']); started=true;
 const cert=join(dir,'tls.crt'),key=join(dir,'tls.key');
 const tls=spawnSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-config','C:/Program Files/Git/usr/ssl/openssl.cnf'],{stdio:'ignore',windowsHide:true});
 if(tls.status!==0)throw new Error('Disposable local TLS fixture generation failed.');
 const env={...process.env,SITE_FACTORY_TEST_TLS_CERT:cert,SITE_FACTORY_TEST_TLS_KEY:key,SITE_FACTORY_TEST_DB:JSON.stringify({host:'127.0.0.1',port,user:'test_admin',password,database:'postgres'})};
 const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','--pool=threads',...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:true});
 process.exitCode=result.status??1;
} finally {
 if(started)run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
 const absolute=realpathSync(dir); if(!absolute.startsWith(realpathSync(root)+'\\')&&!absolute.startsWith(realpathSync(root)+'/'))throw new Error('Unsafe test cleanup path');
 rmSync(absolute,{recursive:true,force:true});
}
