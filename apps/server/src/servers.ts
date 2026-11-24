import {logFailure} from './diagnostics.js';
import type {Pool} from 'pg';
import ssh2,{Client} from 'ssh2';
import {createHash,randomUUID} from 'node:crypto';
import {isIPv4,isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AppError} from '../../../packages/contracts/src/model.js';
import {protectSecret} from './secrets.js';
import {sshExecute,type LinuxHost} from './linux-publisher.js';

type Bootstrap={password?:string;privateKey?:string;passphrase?:string};
const {utils}=ssh2;
type HostOperation={kind:'addresses'|'rotate'|'connection'|'check';previousStatus:string;nextCredential?:string;publicKey?:string;oldPublicKey?:string;step?:string;connection?:{name:string;host:string;port:number;username:string}};
type HostRow={id:string;name:string;host:string;port:number;username:string;host_fingerprint:string|null;credential:string;bootstrap:string|null;operation:HostOperation|null;config:{additionalIPv4:string[];publicKey:string;sourceIPv4?:string;localPort?:number};phase:string;status:string};
export function publicIPv4(value:unknown):string{
  if(typeof value!=='string'||!isIPv4(value))throw new AppError('INVALID_INPUT','Укажите публичный IPv4 сервера.');
  const [a,b]=value.split('.').map(Number) as [number,number];
  if(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19))throw new AppError('INVALID_INPUT','Нужен публичный адрес, доступный с Windows VPS.');
  if(Object.values(networkInterfaces()).flat().some(n=>n?.address===value))throw new AppError('INVALID_INPUT','Укажите Linux VPS, а не управляющий сервер.');
  return value;
}
export function validateServer(body:Record<string,unknown>){
  const host=publicIPv4(body.host),port=Number(body.port??22),username=String(body.username??''),name=String(body.name??'').trim();
  if(!Number.isInteger(port)||port<1||port>65535||!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)||!name||name.length>80)throw new AppError('INVALID_INPUT','Проверьте название, SSH-порт и логин.');
  const additionalIPv4=[...new Set(String(body.additionalIPv4??'').split(/[\s,;]+/).filter(Boolean).map(publicIPv4))].filter(v=>v!==host);
  if(additionalIPv4.length>256)throw new AppError('INVALID_INPUT','За один раз поддерживается до 256 дополнительных IPv4.');
  const fingerprint=String(body.fingerprint??'').trim();if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))throw new AppError('INVALID_INPUT','Укажите проверенный SHA256 отпечаток SSH из консоли сервера.');
  const auth:Bootstrap=body.authType==='key'?{privateKey:String(body.privateKey??''),...(body.passphrase?{passphrase:String(body.passphrase)}:{})}:{password:String(body.password??'')};
  if(auth.privateKey?auth.privateKey.length>32768||!auth.privateKey.includes('PRIVATE KEY'):!auth.password||auth.password.length>4096)throw new AppError('INVALID_INPUT','Укажите пароль или приватный SSH-ключ.');
  return {host,port,username,name,additionalIPv4,fingerprint,auth};
}
function hostObject(row:HostRow):LinuxHost{return {host:row.host,port:row.port,username:row.username,hostFingerprint:row.host_fingerprint!,privateKeyEncrypted:row.credential};}
async function discoverFingerprint(host:string,port:number){
  return new Promise<string>((resolve,reject)=>{
    const client=new Client();let found=false;
    const timer=setTimeout(()=>{client.destroy();reject(new AppError('UNAVAILABLE','SSH-сервер не ответил.'));},20000);
    client.on('error',()=>{clearTimeout(timer);if(!found)reject(new AppError('UNAVAILABLE','Не удалось прочитать отпечаток SSH.'));}).connect({host,port,username:'site-factory-probe',readyTimeout:15000,hostVerifier:(key:Buffer)=>{found=true;clearTimeout(timer);resolve('SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,''));return false;}});
  });
}
export type ProvisionPorts={execute:typeof sshExecute;fingerprint:(host:string,port:number)=>Promise<string>};
export async function createServers(pool:Pool,root:string,data:string,override?:ProvisionPorts,initiallyPaused=false){
  const execute=override?.execute??sshExecute, fingerprint=override?.fingerprint??discoverFingerprint;
  // Import the existing enrolled VPS without touching its network or publications.
  try{
    const legacy=JSON.parse(await readFile(join(data,'ssh','ovh-pilot.json'),'utf8'));
    const addresses=(await pool.query("select host(address) address from factory.hosting_addresses where host_id='ovh-pilot'")).rows.map(r=>r.address);
    await pool.query(`insert into factory.hosting_hosts(id,name,host,port,username,host_fingerprint,credential,config,status,phase) values('ovh-pilot','OVH · Gravelines',$1,$2,$3,$4,$5,$6,'ready','ready') on conflict do nothing`,[legacy.host,legacy.port,legacy.username,legacy.hostFingerprint,legacy.privateKeyEncrypted,{additionalIPv4:addresses.filter(ip=>ip!==legacy.host),publicKey:legacy.publicKey}]);
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const codeRoot=process.env.SITE_FACTORY_INSTALL_ROOT??root;
  const helper=await readFile(join(codeRoot,'scripts/linux/provision.py'),'utf8'),publisher=await readFile(join(codeRoot,'scripts/linux/publish.py'));
  const helperCommand="python3 -c \"import base64;exec(base64.b64decode('"+Buffer.from(helper).toString('base64')+"'))\"";
  async function verifyHttp(addresses:string[]){
    if(override)return;
    await Promise.all(addresses.map(async ip=>{try{const response=await fetch(`http://${ip}/__site_factory_connection_check`,{redirect:'error',signal:AbortSignal.timeout(10000)});await response.body?.cancel();if(response.status!==404)throw Error('unexpected response');}catch{throw new AppError('UNAVAILABLE','HTTP недоступен на '+ip+'. Проверьте сетевой firewall провайдера и порт 80.');}}));
  }
  let closed=false,paused=initiallyPaused,ticking:Promise<void>|null=null;
  const list=async()=>(await pool.query(`select h.id,h.name,host(h.host) host,h.port,h.username,h.host_fingerprint,h.status,h.phase,h.error,h.report,h.config-'publicKey' as config,h.created_at,h.updated_at,h.checked_at,h.operation->>'kind' operation,
    coalesce((select jsonb_agg(jsonb_build_object('address',host(a.address),'siteId',a.site_id,'state',a.state,'releaseAfter',a.release_after) order by a.priority,a.address) from factory.hosting_addresses a where a.host_id=h.id),'[]') addresses from factory.hosting_hosts h order by h.created_at`)).rows;
  async function maintain(id:string,body:Record<string,unknown>){
    const action=String(body.action??''),tx=await pool.connect();
    try{
      await tx.query('begin');await tx.query('select pg_advisory_xact_lock(78424520)');
      const row=(await tx.query('select *,host(host) host from factory.hosting_hosts where id=$1 for update',[id])).rows[0] as HostRow|undefined;
      const recoveryRepair=paused&&action==='connection'&&row?.status==='failed'&&row.phase==='maintenance'&&row.operation?.kind==='connection';
      if(!row||(!recoveryRepair&&!['ready','draining','retired'].includes(row.status)))throw new AppError('CONFLICT','Сначала завершите текущую настройку сервера.');
      if(!paused&&(await tx.query("select 1 from factory.hosting_jobs j join factory.hosting_addresses a on a.address=j.address where a.host_id=$1 and j.status in ('queued','running','waiting')",[id])).rowCount)throw new AppError('CONFLICT','Дождитесь завершения публикаций на сервере.');
      if(action==='drain'||action==='retire'){
        if(action==='retire'&&(await tx.query('select 1 from factory.hosting_addresses where host_id=$1 and site_id is not null',[id])).rowCount)throw new AppError('CONFLICT','Сначала перенесите сайты и освободите закреплённые IPv4.');
        await tx.query('update factory.hosting_hosts set status=$2,updated_at=now() where id=$1',[id,action==='drain'?'draining':'retired']);await tx.query('commit');return {id};
      }
      if(!['addresses','rotate','connection','check','activate'].includes(action))throw new AppError('INVALID_INPUT','Неизвестная операция сервера.');
      const operation:HostOperation={kind:action==='activate'?'check':action as HostOperation['kind'],previousStatus:recoveryRepair?row.operation!.previousStatus:action==='activate'?'ready':row.status==='retired'?'draining':row.status};
      if(action==='addresses'){
        const additions=[...new Set(String(body.addresses??'').split(/[\s,;]+/).filter(Boolean).map(publicIPv4))];
        if(!additions.length||additions.length>64)throw new AppError('INVALID_INPUT','Укажите от 1 до 64 выделенных провайдером IPv4.');
        if((await tx.query('select 1 from factory.hosting_addresses where address=any($1::inet[])',[additions])).rowCount)throw new AppError('CONFLICT','Один из IPv4 уже есть в конвейере.');
        row.config.additionalIPv4=[...new Set([...row.config.additionalIPv4,...additions])];
        for(const ip of additions)await tx.query("insert into factory.hosting_addresses(address,host_id,state) values($1,$2,'provisioning')",[ip,id]);
      }
      if(action==='rotate'){const pair=utils.generateKeyPairSync('ed25519',{});operation.nextCredential=await protectSecret(pair.private);operation.publicKey=pair.public;operation.oldPublicKey=row.config.publicKey;operation.step='install';}
      let bootstrap:string|null=null;
      if(action==='connection'){
        const candidate={name:String(body.name??row.name).trim(),host:publicIPv4(body.host??row.host),port:Number(body.port??row.port),username:String(body.username??row.username)};
        if(!candidate.name||candidate.name.length>80||!Number.isInteger(candidate.port)||candidate.port<1||candidate.port>65535||!/^[a-z_][a-z0-9_-]{0,31}$/.test(candidate.username))throw new AppError('INVALID_INPUT','Проверьте параметры SSH.');
        if(body.fingerprint&&body.fingerprint!==row.host_fingerprint)throw new AppError('CONFLICT','Отпечаток существующего сервера менять этой операцией нельзя.');
        if(body.password||body.privateKey){const checked=validateServer({...body,...candidate,fingerprint:row.host_fingerprint});bootstrap=await protectSecret(JSON.stringify(checked.auth));}
        operation.connection=candidate;
      }
      await tx.query("update factory.hosting_hosts set operation=$2,config=$3,bootstrap=$4,status='queued',phase='maintenance',error=null,updated_at=now() where id=$1",[id,operation,row.config,bootstrap]);
      await tx.query('commit');return {id};
    }catch(error){await tx.query('rollback');throw error;}finally{tx.release();}
  }
  async function add(body:Record<string,unknown>){
    const input=validateServer(body),id=randomUUID(),key=utils.generateKeyPairSync('ed25519',{});
    const tx=await pool.connect();
    try{await tx.query('begin');await tx.query('select pg_advisory_xact_lock(78424520)');
      if((await tx.query('select 1 from factory.hosting_addresses where address=any($1::inet[])',[[input.host,...input.additionalIPv4]])).rowCount)throw new AppError('CONFLICT','Один из IPv4 уже добавлен в конвейер.');
      await tx.query(`insert into factory.hosting_hosts(id,name,host,port,username,host_fingerprint,credential,bootstrap,config) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,input.name,input.host,input.port,input.username,input.fingerprint||null,await protectSecret(key.private),await protectSecret(JSON.stringify(input.auth)),{additionalIPv4:input.additionalIPv4,publicKey:key.public}]);
      for(const [priority,address] of [...input.additionalIPv4,input.host].entries())await tx.query('insert into factory.hosting_addresses(address,host_id,priority) values($1,$2,$3)',[address,id,priority]);
      await tx.query('commit');return {id};
    }catch(e){await tx.query('rollback');if((e as {code?:string}).code==='23505')throw new AppError('CONFLICT','Этот сервер или IPv4 уже добавлен.');throw e;}finally{tx.release();}
  }
  async function retry(id:string){const r=await pool.query("update factory.hosting_hosts set status='queued',error=null,updated_at=now() where id=$1 and status='failed' returning id",[id]);if(!r.rowCount)throw new AppError('CONFLICT','Нет остановленной настройки для повтора.');return r.rows[0];}
  async function credentials(id:string,body:Record<string,unknown>){
    const current=(await pool.query("select *,host(host) host from factory.hosting_hosts where id=$1 and status='failed' and phase='connect'",[id])).rows[0];
    if(!current)throw new AppError('CONFLICT','Данные первого входа можно исправить только при ошибке подключения.');
    const input=validateServer({...body,fingerprint:current.host_fingerprint??body.fingerprint,host:current.host,port:current.port,name:current.name,additionalIPv4:''});
    if(body.fingerprint&&current.host_fingerprint&&body.fingerprint!==current.host_fingerprint)throw new AppError('CONFLICT','Отпечаток существующего сервера менять этой операцией нельзя.');
    const result=await pool.query("update factory.hosting_hosts set username=$2,bootstrap=$3,host_fingerprint=coalesce(host_fingerprint,$4),status='queued',error=null,updated_at=now() where id=$1 and status='failed' and phase='connect' returning id",[id,input.username,await protectSecret(JSON.stringify(input.auth)),input.fingerprint]);
    if(!result.rowCount)throw new AppError('CONFLICT','Состояние сервера изменилось.');return result.rows[0];
  }
  async function prepare(row:HostRow){
    const phase=async(value:string)=>{row.phase=value;await pool.query('update factory.hosting_hosts set phase=$2,updated_at=now() where id=$1',[row.id,value]);};
    if(!row.host_fingerprint)throw new AppError('INVALID_INPUT','Укажите проверенный SSH-отпечаток из консоли сервера перед подключением.');
    const host=hostObject(row),sudo=row.username==='root'?'':'sudo -n ';
    const check=sudo+'true';
    const verifySSH=async()=>{
      const auth={privateKey:await protectSecret(host.privateKeyEncrypted,true)},addresses=[row.host,...row.config.additionalIPv4];
      // Respect OpenSSH MaxStartups and avoid one DPAPI process per address.
      for(let i=0;i<addresses.length;i+=6)await Promise.all(addresses.slice(i,i+6).map(ip=>execute({...host,host:ip},check,'',30000,auth)));
    };
    const run=async(action:string)=>JSON.parse(await execute(host,sudo+helperCommand,JSON.stringify({action,id:row.id,host:row.host,port:row.port,...row.config,...(action==='packages'?{publisher:publisher.toString('base64'),publisherHash:createHash('sha256').update(publisher).digest('hex')}:{})}),900000));
    if(row.phase==='maintenance'&&row.operation){
      const operation=row.operation;
      const keyScript=await readFile(join(codeRoot,'scripts/linux/manage-key.py'));
      const keyCommand="python3 -c \"import base64;exec(base64.b64decode('"+keyScript.toString('base64')+"'))\"";
      const manageKey=(connection:LinuxHost,action:string,publicKey:string,source?:string,auth?:Bootstrap)=>execute(connection,keyCommand,JSON.stringify({action,publicKey,source,id:row.id}),30000,auth);
      if(operation.kind==='connection'){
        const next={...host,...operation.connection!},auth=row.bootstrap?JSON.parse(await protectSecret(row.bootstrap,true)) as Bootstrap:undefined;
        const check=(next.username==='root'?'':'sudo -n ')+'true';
        const source=(await execute(next,check+' && printf "%s" "$SSH_CONNECTION"','',30000,auth)).trim().split(/\s+/);
        if(!isIP(source[0]??''))throw new AppError('UNAVAILABLE','Не определён источник SSH.');
        const localPort=Number(source[3]);if(!Number.isInteger(localPort)||localPort<1||localPort>65535)throw new AppError('UNAVAILABLE','SSH не сообщил корректный порт сервера.');
        await manageKey(next,'install',row.config.publicKey,source[0],auth);await execute(next,check,'',30000);
        await pool.query('update factory.hosting_hosts set name=$2,host=$3,port=$4,username=$5,bootstrap=null where id=$1',[row.id,next.name,next.host,next.port,next.username]);
        row.config={...row.config,sourceIPv4:source[0]!,localPort};
      }
      if(operation.kind==='rotate'){
        const next={...host,privateKeyEncrypted:operation.nextCredential!};
        if(operation.step!=='remove'){
          const source=(await execute(host,check+' && printf "%s" "$SSH_CONNECTION"','',30000)).trim().split(/\s+/)[0];if(!source||!isIP(source))throw new AppError('UNAVAILABLE','Не определён источник SSH.');
          await manageKey(host,'install',operation.publicKey!,source);await execute(next,check,'',30000);
          operation.step='remove';row.config.publicKey=operation.publicKey!;
          await pool.query('update factory.hosting_hosts set credential=$2,config=$3,operation=$4 where id=$1',[row.id,operation.nextCredential,row.config,operation]);
        }
        await manageKey(next,'remove',operation.oldPublicKey!);await execute(next,check,'',30000);
      }
      if(operation.kind==='addresses'){
        await run('recover-network');const result=await run('network');
        if(result.rollback){await verifySSH();await verifyHttp([row.host,...row.config.additionalIPv4]);await run('confirm-network');}
      }
      if(operation.kind==='check'||operation.kind==='addresses'){const report=await run('verify');await verifyHttp([row.host,...row.config.additionalIPv4]);await pool.query('update factory.hosting_hosts set report=coalesce(report,\'{}\')||$2::jsonb where id=$1',[row.id,report]);}
      await pool.query("update factory.hosting_addresses set state='free' where host_id=$1 and state='provisioning'",[row.id]);
      await pool.query("update factory.hosting_hosts set status=$2,phase='ready',operation=null,bootstrap=null,error=null,config=$3,checked_at=now(),updated_at=now() where id=$1",[row.id,operation.previousStatus,row.config]);return;
    }
    if(row.phase==='connect'){
      const bootstrap=row.bootstrap?JSON.parse(await protectSecret(row.bootstrap,true)) as Bootstrap:undefined;
      // Check privilege and source address before installing a restricted automation key.
      const connection=(await execute(host,check+' && printf "%s" "$SSH_CONNECTION"','',30000,bootstrap)).trim().split(/\s+/);
      if(!isIP(connection[0]??'')||!Number.isInteger(Number(connection[3])))throw new AppError('UNAVAILABLE','Не удалось определить адрес управления SSH.');
      row.config={...row.config,sourceIPv4:connection[0]!,localPort:Number(connection[3])};
      const line=`from="${connection[0]}",restrict ${row.config.publicKey} site-factory-${row.id}`;
      await execute(host,`umask 077; mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys" && (grep -qF 'site-factory-${row.id}' "$HOME/.ssh/authorized_keys" || printf '%s' '${Buffer.from('\n'+line+'\n').toString('base64')}' | base64 -d >> "$HOME/.ssh/authorized_keys")`,'',30000,bootstrap);
      await execute(host,check,'',30000);
      await pool.query('update factory.hosting_hosts set bootstrap=null,config=$2 where id=$1',[row.id,row.config]);await phase('inspect');
    }
    if(row.phase==='inspect'){const report=await run('inspect');await pool.query('update factory.hosting_hosts set report=$2 where id=$1',[row.id,report]);await phase('packages');}
    if(row.phase==='packages'){await run('packages');await phase('network');}
    for(const action of ['network','firewall'])if(row.phase===action){
      // A previous attempt may have lost its connection after arming rollback.
      await run('recover-'+action);
      const result=await run(action);
      if(result.rollback){
        await verifySSH();
        if(action==='firewall')await verifyHttp([row.host,...row.config.additionalIPv4]);
        await run('confirm-'+action);
      }
      await phase(action==='network'?'firewall':'verify');
    }
    if(row.phase==='verify'){
      const report=await run('verify');
      await verifySSH();
      await verifyHttp([row.host,...row.config.additionalIPv4]);
      await pool.query("update factory.hosting_hosts set status='ready',phase='ready',error=null,report=coalesce(report,'{}')||$2::jsonb,checked_at=now(),updated_at=now() where id=$1",[row.id,JSON.stringify(report)]);
    }
  }
  async function work(onlyId?:string){
    const tx=await pool.connect();let locked=false;
    try{locked=(await tx.query('select pg_try_advisory_lock(78424522) ok')).rows[0].ok;if(!locked)return;
      const row=(await tx.query("select *,host(host) host from factory.hosting_hosts where status in ('queued','running') and ($1::text is null or id=$1 and phase='maintenance' and operation->>'kind'='connection') order by created_at limit 1",[onlyId??null])).rows[0] as HostRow|undefined;if(!row)return;
      await tx.query("update factory.hosting_hosts set status='running',updated_at=now() where id=$1",[row.id]);
      try{await prepare(row);}catch(e){await tx.query("update factory.hosting_hosts set status='failed',error=$2,updated_at=now() where id=$1",[row.id,e instanceof AppError?e.message:'Настройка остановлена. Проверьте доступ SSH, ОС и повторите.']);}
    }finally{if(locked)await tx.query('select pg_advisory_unlock(78424522)');tx.release();}
  }
  const tick=()=>{if(closed||paused)return Promise.resolve();if(!ticking)ticking=work().finally(()=>{ticking=null;});return ticking;};
  const timer=setInterval(()=>void tick().catch(e=>logFailure('servers.tick',e)),3000);timer.unref();
  return {async pause(){paused=true;await ticking;},resume(){paused=false;},list,add,maintain,async repairConnection(id:string,body:Record<string,unknown>){if(!paused)throw new AppError('CONFLICT','Используйте обычное обслуживание сервера.');await maintain(id,{...body,action:'connection'});if(!ticking)ticking=work(id).finally(()=>{ticking=null;});await ticking;},retry,credentials,tick,async close(){closed=true;clearInterval(timer);await ticking;}};
}
