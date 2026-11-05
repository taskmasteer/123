import type {Pool} from 'pg';
import {request as httpsRequest} from 'node:https';
import type {TLSSocket} from 'node:tls';
import {publicationDomain} from './hosting-policy.js';
import {propagated,verifyHostedRelease} from './hosting.js';
export type MonitorPorts={dns:typeof propagated;health:typeof verifyHostedRelease;certificate:(domain:string,ip:string)=>Promise<number>};
export function certificateExpiry(domain:string,ip:string):Promise<number>{
  publicationDomain(domain);
  return new Promise((resolve,reject)=>{
    // A resumed TLS session may omit the peer certificate. Use a fresh handshake
    // for this inspection rather than the shared HTTPS agent's session cache.
    const req=httpsRequest({hostname:ip,port:443,servername:domain,agent:false,path:'/__site_factory_release',headers:{Host:domain},rejectUnauthorized:true,timeout:10000},res=>{
      const value=Date.parse((res.socket as TLSSocket).getPeerCertificate().valid_to);res.resume();Number.isFinite(value)?resolve(value):reject(Error('certificate'));
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('timeout')));req.end();
  });
}
export async function createMonitoring(pool:Pool,override?:MonitorPorts){
  const ports=override??{dns:propagated,health:verifyHostedRelease,certificate:certificateExpiry};
  let paused=false,closed=false,running:Promise<void>|null=null;
  async function check(siteId:string){
    const row=(await pool.query('select b.*,host(b.address) ip,s.domain from factory.hosting_sites b join public.sites s on s.id=b.site_id where b.site_id=$1',[siteId])).rows[0];
    if(!row)return;publicationDomain(row.domain);
    const checks:Record<string,unknown>={};
    for(const [name,action] of [['dns',()=>ports.dns(row.domain,row.ip).then(ok=>{if(!ok)throw Error('DNS');})],['http',()=>ports.health(row.domain,row.ip,row.revision_id,false)],['https',()=>ports.health(row.domain,row.ip,row.revision_id,true)]] as const){try{await action();checks[name]=true;}catch{checks[name]=false;}}
    try{checks.certificateExpiresAt=new Date(await ports.certificate(row.domain,row.ip)).toISOString();}catch{checks.certificateExpiresAt=null;}
    const expiry=typeof checks.certificateExpiresAt==='string'?Date.parse(checks.certificateExpiresAt):0;
    const status=!checks.dns||!checks.http||!checks.https||!expiry?'failed':expiry-Date.now()<14*86400000?'warning':'healthy';
    // A concurrent deployment must not attach an old result to its new binding.
    await pool.query(`insert into factory.hosting_health(site_id,revision_id,address,status,checks,checked_at,next_check)
      select site_id,revision_id,address,$4,$5,now(),now()+interval '5 minutes' from factory.hosting_sites where site_id=$1 and revision_id=$2 and address=$3::inet
      on conflict(site_id) do update set revision_id=excluded.revision_id,address=excluded.address,status=excluded.status,checks=excluded.checks,checked_at=excluded.checked_at,next_check=excluded.next_check`,[siteId,row.revision_id,row.ip,status,checks]);
  }
  async function work(){
    const tx=await pool.connect();let locked=false;
    try{locked=(await tx.query('select pg_try_advisory_lock(78424523) ok')).rows[0].ok;if(!locked)return;
      const row=(await tx.query(`select s.site_id from factory.hosting_sites s left join factory.hosting_health h using(site_id)
        where (h.site_id is null or h.next_check<=now() or h.revision_id<>s.revision_id or h.address<>s.address)
        and not exists(select 1 from factory.hosting_jobs j where j.site_id=s.site_id and j.status in ('queued','running','waiting'))
        order by h.next_check nulls first limit 1`)).rows[0];if(row)await check(row.site_id);
    }finally{if(locked)await tx.query('select pg_advisory_unlock(78424523)');tx.release();}
  }
  const tick=()=>{if(paused||closed)return Promise.resolve();if(!running)running=work().finally(()=>{running=null;});return running;};
  const timer=setInterval(()=>void tick().catch(()=>{}),10000);timer.unref();
  return {check,tick,request:async(id:string)=>{await pool.query('update factory.hosting_health set next_check=now() where site_id=$1',[id]);},async pause(){paused=true;await running;},resume(){paused=false;},async close(){closed=true;clearInterval(timer);await running;}};
}
