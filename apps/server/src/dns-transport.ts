import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Pool} from 'pg';
import {AppError} from '../../../packages/contracts/src/model.js';

/** All API processes share the credential's schedule, including across restarts. */
export function dnsTransport(pool:Pool,provider:'namecheap'|'godaddy',identity:string,transport:typeof fetch=fetch):typeof fetch{
 const key=createHash('sha256').update(provider+':'+identity).digest('hex');
 const interval=provider==='namecheap'?11000:1100;
 return async(input,init)=>{
  const tx=await pool.connect();let wait=0;
  try{
   await tx.query('begin');
   await tx.query('insert into factory.dns_limits(key,next_at) values($1,now()) on conflict do nothing',[key]);
   const row=(await tx.query('select greatest(0,extract(epoch from (next_at-clock_timestamp()))*1000) wait from factory.dns_limits where key=$1 for update',[key])).rows[0];
   wait=Math.ceil(Number(row.wait));
   if(wait>30000)throw new AppError('UNAVAILABLE',provider==='namecheap'?'Namecheap HTTP 429. Ожидаем разрешённое время следующего запроса.':'GoDaddy HTTP 429. Ожидаем разрешённое время следующего запроса.');
   await tx.query("update factory.dns_limits set next_at=greatest(next_at,clock_timestamp())+$2*interval '1 millisecond' where key=$1",[key,interval]);
   await tx.query('commit');
  }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
  if(wait)await delay(wait,undefined,{signal:init?.signal??undefined});
  const response=await transport(input,init);
  if(response.status===429||response.status===503){
   const header=response.headers.get('retry-after'),ms=header&&/^\d+(\.\d+)?$/.test(header)?Number(header)*1000:header?Date.parse(header)-Date.now():60000;
   await pool.query("update factory.dns_limits set next_at=greatest(next_at,clock_timestamp()+$2*interval '1 millisecond') where key=$1",[key,Math.max(1000,Number.isFinite(ms)?ms:60000)]);
  }
  return response;
 };
}
