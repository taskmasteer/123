import {dnsTransport} from './dns-transport.js';
import type { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AppError } from '../../../packages/contracts/src/model.js';
import type { Principal,ArtifactFile,SiteInput } from '../../../packages/contracts/src/model.js';
import type { SupabaseRepository,SqlTransaction } from '../../../packages/adapters/src/supabase-repository.js';
import type { R2Store } from '../../../packages/adapters/src/r2-store.js';
import { uuid } from '../../../packages/contracts/src/http.js';
import { GoDaddyDns } from './godaddy.js';
import { publicationDomain } from './hosting-policy.js';
import { protectSecret } from './secrets.js';
import { NamecheapDns, mergeIPv4, zoneHash } from './namecheap.js';
import type { DnsZone,NamecheapConfig } from './namecheap.js';
import { linuxPublish,linuxMaintain } from './linux-publisher.js';
import type { DeployTarget,LinuxHost } from './linux-publisher.js';

export type HostingPorts={maintain?:(host:LinuxHost,target:DeployTarget,action:'bindings'|'remove'|'prune',keep?:string[])=>Promise<unknown>;publish:(target:DeployTarget,files?:ArtifactFile[])=>Promise<unknown>;dns:{read:(domain:string)=>Promise<DnsZone>;write:(zone:DnsZone,before?:DnsZone)=>Promise<void>};propagated:(domain:string,ip:string)=>Promise<boolean>;health:(domain:string,ip:string,revision:string,tls:boolean,certificatePending?:boolean)=>Promise<void>};
export function transientPublicationError(error:unknown):error is AppError{
  return error instanceof AppError&&error.code==='UNAVAILABLE'&&/^(SSH-подключение не выполнено|Превышено время операции SSH|HTTP-проверка не прошла|HTTPS-проверка не прошла|Проверка опубликованной версии не прошла|(?:Namecheap|GoDaddy) не ответил|(?:Namecheap|GoDaddy) HTTP (429|5\d\d))/.test(error.message);
}
export async function verifyHostedRelease(domain:string,ip:string,revision:string,tls:boolean,certificatePending=false){
  publicationDomain(domain);const deadline=Date.now()+10000;
  async function get(path:string,max:number,secure=tls){
    return new Promise<{body:string;type:string;redirected:boolean}>((resolve,reject)=>{
      const req=(secure?httpsRequest:httpRequest)({hostname:ip,port:secure?443:80,path,headers:{Host:domain},...(secure?{servername:domain,rejectUnauthorized:true}:{})},response=>{
        let body='',bytes=0;response.on('data',chunk=>{bytes+=chunk.length;if(bytes>max)req.destroy(new Error('response limit'));else body+=chunk;});
        response.on('error',()=>reject(new AppError('UNAVAILABLE','Проверка опубликованной версии не прошла.')));
        response.on('end',()=>{
          clearTimeout(timer);
          const redirected=!secure && path==='/' && response.statusCode===308 && response.headers.location==='https://'+domain+'/';
          if(response.statusCode===200 || redirected)resolve({body,type:String(response.headers['content-type']??''),redirected});
          else reject(new AppError('UNAVAILABLE','Проверка опубликованной версии не прошла.'));
        });
      });
      const timer=setTimeout(()=>req.destroy(new Error('timeout')),Math.max(1,deadline-Date.now()));
      req.on('error',()=>{clearTimeout(timer);reject(new AppError('UNAVAILABLE',secure?'HTTPS-проверка не прошла.':'HTTP-проверка не прошла.'));});req.end();
    });
  }
  const marker=await get('/__site_factory_release',1000);
  if(marker.body!==revision)throw new AppError('UNAVAILABLE','Проверка опубликованной версии не прошла.');
  let page=await get('/',2000000);
  if(page.redirected){
    // During upload an existing certificate may be due for renewal. The final
    // HTTPS phase verifies the page after ACME has had a chance to run.
    if(certificatePending)return;
    page=await get('/',2000000,true);
  }
  if(!/^text\/html\b/i.test(page.type)||!/<[a-z][^>]*>/i.test(page.body))throw new AppError('UNAVAILABLE','Проверка опубликованной версии не прошла: главная страница пуста или не является HTML.');
}
export async function propagated(domain:string,ip:string){
  publicationDomain(domain);
  for(const server of ['1.1.1.1','8.8.8.8']){
    const resolver=new Resolver({timeout:4000,tries:1});resolver.setServers([server]);
    try{const a=await resolver.resolve4(domain);const aaaa=await resolver.resolve6(domain).catch((e:NodeJS.ErrnoException)=>{if(['ENODATA','ENOTFOUND'].includes(e.code??''))return [];throw e;});if(!a.length||a.some(v=>v!==ip)||aaaa.length)return false;}catch{return false;}
  }
  return true;
}
type Job={dns_provider:string;id:string;site_id:string;revision_id:string;address:string;action:string;phase:string;status:string;dns_before:DnsZone|null;dns_after:DnsZone|null;created_at:Date};
export async function createHosting(pool:Pool,repository:SupabaseRepository,store:R2Store,data:string,portsOverride?:HostingPorts,initiallyPaused=false){
  const ready=async()=>!!portsOverride||!!(await pool.query("select 1 from factory.hosting_hosts where status in ('ready','draining') limit 1")).rowCount;
  let dns:NamecheapDns|null=null,ncConfig:NamecheapConfig|null=null,gd:GoDaddyDns|null=null;
  const godaddy=(await pool.query("select value from factory.settings where key='godaddy'")).rows[0];
  if(godaddy)try{const token=await protectSecret(godaddy.value,true);gd=new GoDaddyDns(token,dnsTransport(pool,'godaddy','installation'));}catch{}
  const secret=(await pool.query("select value from factory.settings where key='namecheap'")).rows[0];
  if(secret){try{ncConfig=JSON.parse(await protectSecret(secret.value,true));dns=new NamecheapDns(ncConfig!);}catch{}}
  const providerCache=new Map<string,NamecheapDns>();
  function provider(name:string,domain:string){if(name==='godaddy'&&gd)return gd;if(name==='namecheap'&&ncConfig){if(!providerCache.has(domain))providerCache.set(domain,new NamecheapDns(ncConfig,dnsTransport(pool,'namecheap',ncConfig.username.toLowerCase()),[domain]));return providerCache.get(domain)!;}throw new AppError('UNAVAILABLE','Подключите '+(name==='godaddy'?'GoDaddy':'Namecheap')+' в настройках.');}
  async function defaultProvider(domain:string,tx:Pick<SqlTransaction,'query'>=pool){
    publicationDomain(domain);
    const saved=(await tx.query('select provider from factory.hosting_domains where domain=$1',[domain])).rows[0]?.provider;
    if(saved)return saved as string;
    if(portsOverride)return 'namecheap';
    if(!!ncConfig!==!!gd)return ncConfig?'namecheap':'godaddy';
    throw new AppError('INVALID_INPUT','Выберите DNS-провайдера для '+domain+' в настройках доменов.');
  }
  async function setDomainProvider(domainValue:unknown,name:unknown){
    if(typeof domainValue!=='string'||!['namecheap','godaddy'].includes(String(name)))throw new AppError('INVALID_INPUT','Укажите домен и DNS-провайдера.');
    const domain=publicationDomain(domainValue);provider(String(name),domain);
    const tx=await pool.connect();try{await tx.query('begin');await tx.query('select pg_advisory_xact_lock(78424520)');
      if((await tx.query('select 1 from public.sites where domain=$1 and archived_at is null',[domain])).rowCount)throw new AppError('CONFLICT','Провайдер существующего сайта меняется через согласованный перенос DNS.');
      await tx.query('insert into factory.hosting_domains values($1,$2) on conflict(domain) do update set provider=$2',[domain,name]);await tx.query('commit');
    }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
  }
  const domainProviders=async()=>(await pool.query('select domain,provider from factory.hosting_domains order by domain')).rows;
  async function generationPreflight(siteId:string){
    const site=await repository.get(siteId);if(!site)throw new AppError('NOT_FOUND','Сайт не найден.');
    const domain=publicationDomain(site.domain),name=await defaultProvider(domain);
    const address=(await pool.query('select host(address) ip from factory.hosting_addresses where site_id=$1 order by priority,address limit 1',[siteId])).rows[0]?.ip;
    if(!address)throw new AppError('CONFLICT','IPv4 не закреплён за сайтом.');
    try{const zone=await (portsOverride?.dns??provider(name,domain)).read(domain);mergeIPv4(zone,address);}
    catch(e){if(transientPublicationError(e))throw new AppError('PROVIDER_WAIT','DNS preflight temporarily unavailable.');throw e;}
  }
  async function batchCapacity(tx:SqlTransaction){
    await tx.query('select pg_advisory_xact_lock(78424520)');
    return Number((await tx.query("select count(*) n from factory.hosting_addresses a left join factory.hosting_hosts h on h.id=a.host_id where a.site_id is null and a.state='free' and (h.status='ready' or $1)",[!!portsOverride])).rows[0].n);
  }
  async function prepareBatch(tx:SqlTransaction,inputs:SiteInput[]){
    for(const input of inputs){const domain=publicationDomain(input.domain);if(!portsOverride)provider(await defaultProvider(domain,tx),domain);}
    const available=await batchCapacity(tx);
    if(available<inputs.length)throw new AppError('CONFLICT',`Для пачки нужно ${inputs.length} свободных IPv4, доступно ${available}. Добавьте адреса в разделе «Серверы» или уменьшите пачку. Генерация ещё не запускалась.`);
  }
  async function reserveBatchSite(tx:SqlTransaction,siteId:string,ownerId:string){
    await batchCapacity(tx);
    const domain=publicationDomain((await tx.query('select domain from public.sites where id=$1',[siteId])).rows[0].domain),name=await defaultProvider(domain,tx);
    const address=(await tx.query("select a.address from factory.hosting_addresses a left join factory.hosting_hosts h on h.id=a.host_id where a.site_id is null and a.state='free' and (h.status='ready' or $1) order by a.priority,a.address limit 1 for update of a",[!!portsOverride])).rows[0]?.address;
    if(!address)throw new AppError('CONFLICT','Нет свободного IPv4 для сайта пачки.');
    await tx.query("update factory.hosting_addresses set site_id=$1,state='reserved',release_after=null where address=$2",[siteId,address]);
    await tx.query('insert into factory.hosting_domains(domain,provider) values($1,$2) on conflict do nothing',[domain,name]);
    await tx.query('insert into factory.auto_publications(site_id,actor) values($1,$2) on conflict do nothing',[siteId,ownerId]);
  }
  let closed=false,paused=initiallyPaused;
  async function status(){return {configured:await ready(),dnsConfigured:!!dns||!!gd||!!portsOverride,providers:{namecheap:!!dns||!!portsOverride,godaddy:!!gd||!!portsOverride},addresses:(await pool.query("select host(a.address) as address,a.host_id,a.site_id,a.state,a.release_after,h.name host_name from factory.hosting_addresses a left join factory.hosting_hosts h on h.id=a.host_id where h.status in ('ready','draining') or $1 order by a.priority,a.address",[!!portsOverride])).rows,sites:(await pool.query(`select distinct on (j.site_id) j.site_id,j.status,j.phase,j.error,b.revision_id live_revision,host(b.address) address,a.host_id,h.name host_name,d.provider,
      case when m.checked_at<now()-interval '10 minutes' then 'stale' else m.status end health_status,m.checked_at,m.checks
      from factory.hosting_jobs j join public.sites s on s.id=j.site_id left join factory.hosting_sites b on b.site_id=s.id left join factory.hosting_addresses a on a.address=b.address left join factory.hosting_hosts h on h.id=a.host_id left join factory.hosting_domains d on d.domain=s.domain left join factory.hosting_health m on m.site_id=b.site_id and m.revision_id=b.revision_id and m.address=b.address order by j.site_id,j.id desc`)).rows};}
  async function jobs(offset=0){return (await pool.query("select j.id,j.site_id,s.domain,j.revision_id,host(j.address) address,j.action,j.status,j.phase,j.error,j.created_at from factory.hosting_jobs j join public.sites s on s.id=j.site_id where s.archived_at is null order by case when j.status in ('queued','running','waiting','failed') then 0 else 1 end,j.id desc limit 51 offset $1",[offset])).rows;}
  async function configureDns(config:NamecheapConfig){
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(config.username)||!/^\S{16,256}$/.test(config.apiKey)||!/^\d+\.\d+\.\d+\.\d+$/.test(config.clientIp))throw new AppError('INVALID_INPUT','Проверьте настройки Namecheap.');
    await pool.query("insert into factory.settings values('namecheap',$1) on conflict(key) do update set value=$1",[await protectSecret(JSON.stringify(config))]);ncConfig=config;dns=new NamecheapDns(config);providerCache.clear();
  }
  async function configureGoDaddy(token:string){if(typeof token!=='string'||!/^\S{16,4096}$/.test(token))throw new AppError('INVALID_INPUT','Проверьте токен GoDaddy.');await pool.query("insert into factory.settings values('godaddy',$1) on conflict(key) do update set value=$1",[await protectSecret(token)]);gd=new GoDaddyDns(token,dnsTransport(pool,'godaddy','installation'));}
  async function details(siteId:string){const site=await repository.get(siteId);const saved=(await pool.query('select provider from factory.hosting_domains where domain=$1',[site?.domain])).rows[0];return {automatic:(await pool.query('select status,error from factory.auto_publications where site_id=$1',[siteId])).rows[0]??null,provider:saved?.provider??await defaultProvider(site?.domain??''),health:(await pool.query("select h.*,case when h.checked_at<now()-interval '10 minutes' then 'stale' else h.status end status from factory.hosting_health h join factory.hosting_sites b using(site_id) where h.site_id=$1 and h.revision_id=b.revision_id and h.address=b.address",[siteId])).rows[0]??null,addresses:(await pool.query('select host(address) address,host_id,state,release_after from factory.hosting_addresses where site_id=$1',[siteId])).rows,binding:(await pool.query('select s.site_id,host(s.address) address,s.revision_id,s.updated_at,a.host_id from factory.hosting_sites s join factory.hosting_addresses a on a.address=s.address where s.site_id=$1',[siteId])).rows[0]??null,jobs:(await pool.query('select id,revision_id,host(address) address,action,status,phase,error,created_at,updated_at,retained from factory.hosting_jobs where site_id=$1 order by id desc limit 30',[siteId])).rows};}
  async function createSite(actor:Principal,input:SiteInput){
    const domain=publicationDomain(input.domain),name=await defaultProvider(domain);
    if(!await ready())throw new AppError('UNAVAILABLE','Сначала подключите Linux-сервер в разделе «Серверы».');
    // Read-only DNS preflight before spending tokens. No zone changes until deployment.
    const zone=await (portsOverride?.dns??provider(name,domain)).read(domain);
    return repository.create(input,actor,async(tx,site)=>{
      await tx.query('select pg_advisory_xact_lock(78424520)');
      const address=(await tx.query("select host(a.address) address from factory.hosting_addresses a left join factory.hosting_hosts h on h.id=a.host_id where a.site_id is null and a.state='free' and (h.status='ready' or $1) order by a.priority,a.address limit 1 for update of a",[!!portsOverride])).rows[0]?.address;
      if(!address)throw new AppError('CONFLICT','Нет свободного IPv4 на готовом сервере. Добавьте адрес в разделе «Серверы».');
      mergeIPv4(zone,address);
      if(name==='godaddy'&&zone.records.filter(r=>r.Type==='A'&&r.Name==='@').length>1)throw new AppError('CONFLICT','В GoDaddy несколько A-записей корня. Оставьте одну перед созданием сайта.');
      await tx.query("update factory.hosting_addresses set site_id=$1,state='reserved',release_after=null where address=$2::inet",[site.id,address]);
      await tx.query('insert into factory.hosting_domains(domain,provider) values($1,$2) on conflict(domain) do nothing',[domain,name]);
      await tx.query('insert into factory.auto_publications(site_id,actor) values($1,$2)',[site.id,actor.userId]);
    });
  }
  async function enqueue(actor:Principal,siteId:string,body:{action?:string;revisionId?:string;address?:string;serverId?:string;provider?:string},automatic=false){
    if(!await ready())throw new AppError('UNAVAILABLE','Linux-сервер ещё не подключён.');
    siteId=uuid(siteId);const site=await repository.scoped(actor,siteId,'site:publish');publicationDomain(site.domain);
    const savedProvider=(await pool.query('select provider from factory.hosting_domains where domain=$1',[site.domain])).rows[0]?.provider;
    const action=body.action??'deploy';if(!['deploy','rollback','replace','migrate','release','prune'].includes(action))throw new AppError('INVALID_INPUT','Неизвестная операция публикации.');
    const dnsProvider=body.provider??savedProvider??await defaultProvider(site.domain);if(!['namecheap','godaddy'].includes(dnsProvider))throw new AppError('INVALID_INPUT','Неизвестный DNS-провайдер.');if(savedProvider&&savedProvider!==dnsProvider&&(await pool.query('select 1 from factory.hosting_sites where site_id=$1',[siteId])).rowCount)throw new AppError('CONFLICT','DNS-провайдер закреплён за опубликованным сайтом.');if(!portsOverride&&!['rollback','prune'].includes(action))provider(dnsProvider,site.domain);
    const revisionId=uuid(body.revisionId??site.draftId);const revision=await repository.revision(revisionId);
    if(!revision||revision.siteId!==siteId||revision.kind==='candidate')throw new AppError('INVALID_INPUT','Выберите принятую версию этого сайта.');
    if(['deploy','replace','migrate'].includes(action)&&site.draftId!==revisionId)throw new AppError('CONFLICT','Черновик обновился. Обновите список и повторите.');
    if(action==='rollback'&&!(await pool.query("select 1 from factory.hosting_jobs where site_id=$1 and revision_id=$2 and status='complete' and retained and action in ('deploy','replace','migrate','rollback')",[siteId,revisionId])).rowCount)throw new AppError('CONFLICT','Откат доступен только к успешно опубликованной версии.');
    const tx=await pool.connect();
    try{
      await tx.query('begin');await tx.query('select pg_advisory_xact_lock_shared(73212,1)');await tx.query('select pg_advisory_xact_lock(78424520)');await repository.fresh(tx,actor);
      if(automatic&&(await tx.query("select status from factory.auto_publications where site_id=$1",[siteId])).rows[0]?.status!=='waiting'){await tx.query('commit');return;}
      if((await tx.query("select 1 from factory.hosting_jobs where site_id=$1 and status in ('queued','running','waiting')",[siteId])).rowCount)throw new AppError('CONFLICT','Публикация этого сайта уже выполняется.');
      const current=(await tx.query('select host(s.address) address,a.host_id from factory.hosting_sites s join factory.hosting_addresses a on a.address=s.address where s.site_id=$1',[siteId])).rows[0];
      if(action==='rollback'&&!current)throw new AppError('CONFLICT','Нет опубликованного сайта для отката.');
      const reserved=(await tx.query('select host_id from factory.hosting_addresses where site_id=$1 limit 1',[siteId])).rows[0];
      if(['migrate','prune'].includes(action)&&!current)throw new AppError('CONFLICT','Сайт ещё не опубликован.');
      const serverId=action==='migrate'?body.serverId:current?.host_id??reserved?.host_id??body.serverId;
      if(action==='migrate'&&(!serverId||serverId===current?.host_id))throw new AppError('INVALID_INPUT','Выберите другой готовый сервер.');
      if(body.serverId&&serverId!==body.serverId)throw new AppError('CONFLICT','Перенос между серверами требует отдельной миграции.');
      const lockedProvider=(await tx.query('select provider from factory.hosting_domains where domain=$1',[site.domain])).rows[0]?.provider;if(current&&lockedProvider&&lockedProvider!==dnsProvider)throw new AppError('CONFLICT','DNS-провайдер уже закреплён.');
      if(current&&body.address&&body.address!==current.address&&!['replace','migrate','release'].includes(action))throw new AppError('CONFLICT','Для смены IPv4 используйте отдельную операцию.');
      const requested=body.address??(action==='migrate'?undefined:current?.address);
      const allocation=(await tx.query(`select host(a.address) address from factory.hosting_addresses a left join factory.hosting_hosts h on h.id=a.host_id where ((a.site_id is null and a.state='free') or a.site_id=$1) and ($2::inet is null or a.address=$2::inet) and ($3::text is null or a.host_id=$3 or $5) and (h.status='ready' or h.status='draining' and a.site_id=$1 or $4) order by (a.site_id is null),a.priority,a.address limit 1 for update of a`,[siteId,requested??null,serverId??null,!!portsOverride,action==='release'])).rows[0];
      if(!allocation)throw new AppError('CONFLICT','Нет свободного IPv4 или выбранный адрес занят.');
      if(action==='release'){
        if(!body.address||current?.address===allocation.address)throw new AppError('CONFLICT','Текущий IPv4 освобождать нельзя.');
        const assigned=(await tx.query('select site_id,state,release_after from factory.hosting_addresses where address=$1',[allocation.address])).rows[0];
        if(assigned.site_id!==siteId||!['reserved','draining'].includes(assigned.state))throw new AppError('CONFLICT','IPv4 не ожидает освобождения.');
        if(assigned.release_after&&new Date(assigned.release_after).getTime()>Date.now())throw new AppError('CONFLICT','Сначала дождитесь истечения срока DNS-кэша.');
      }
      // Keep every explicitly published revision available for repeat upload and rollback.
      await tx.query("select private.assert_payload('artifact',$1)",[revision.manifestId]);
      await tx.query("insert into private.payload_pins(id,kind,payload_id,expires_at) values($1,'artifact',$2,'infinity') on conflict do nothing",[revisionId,revision.manifestId]);
      await tx.query("update factory.hosting_addresses set site_id=$1,state=case when site_id is null then 'reserved' else state end,release_after=case when site_id is null then now()+interval '48 hours' else release_after end where address=$2::inet",[siteId,allocation.address]);
      await tx.query('insert into factory.hosting_domains(domain,provider) values($1,$2) on conflict(domain) do update set provider=excluded.provider',[site.domain,dnsProvider]);
      const job=(await tx.query('insert into factory.hosting_jobs(site_id,revision_id,address,action,actor,dns_provider) values($1,$2,$3,$4,$5,$6) returning id',[siteId,revisionId,allocation.address,action,actor.userId,dnsProvider])).rows[0];
      await tx.query("update factory.auto_publications set status='submitted',error=null where site_id=$1",[siteId]);
      await tx.query('commit');return job;
    }catch(error){await tx.query('rollback');throw error;}finally{tx.release();}
  }
  async function preflight(actor:Principal,siteId:string,excluded:string[]=[]){
    if(!Array.isArray(excluded)||excluded.length>256||excluded.some(v=>typeof v!=='string'))throw new AppError('INVALID_INPUT','Некорректный список адресов.');
    const site=await repository.scoped(actor,uuid(siteId),'site:publish');const domain=publicationDomain(site.domain);
    if(!site.draftId)throw new AppError('CONFLICT','Сначала дождитесь готового черновика.');
    const revision=await repository.revision(site.draftId);if(!revision||revision.kind==='candidate')throw new AppError('CONFLICT','Примите версию в черновик.');
    if((await pool.query("select 1 from factory.hosting_jobs where site_id=$1 and status in ('queued','running','waiting')",[siteId])).rowCount)throw new AppError('CONFLICT','Публикация уже выполняется.');
    const binding=(await pool.query('select host(address) address from factory.hosting_sites where site_id=$1',[siteId])).rows[0];
    const allocation=(await pool.query(`select host(a.address) address,a.host_id from factory.hosting_addresses a join factory.hosting_hosts h on h.id=a.host_id where
      (a.site_id=$1 or a.site_id is null and a.state='free') and (h.status='ready' or h.status='draining' and a.site_id=$1)
      and ($2::inet is null or a.address=$2) and not(host(a.address)=any($3::text[])) order by (a.site_id is null),a.priority,a.address limit 1`,[siteId,binding?.address??null,excluded])).rows[0];
    if(!allocation)throw new AppError('CONFLICT','Нет подходящего свободного IPv4.');
    const saved=(await pool.query('select provider from factory.hosting_domains where domain=$1',[domain])).rows[0];const name=saved?.provider??await defaultProvider(domain);
    const zone=await (portsOverride?.dns??provider(name,domain)).read(domain);mergeIPv4(zone,allocation.address);
    if(name==='godaddy'&&zone.records.filter(r=>r.Type==='A'&&r.Name==='@').length>1)throw new AppError('CONFLICT','В GoDaddy несколько A-записей корня.');
    await store.read(revision.manifestId);
    return {siteId,domain,revisionId:revision.id,address:allocation.address as string,serverId:allocation.host_id as string,provider:name as string};
  }
  async function retry(actor:Principal,siteId:string){
    await repository.scoped(actor,uuid(siteId),'site:publish');
    const result=await pool.query("update factory.hosting_jobs set status='queued',error=null,next_attempt=now(),updated_at=now() where id=(select id from factory.hosting_jobs where site_id=$1 order by id desc limit 1) and status='failed' returning id",[siteId]);
    if(!result.rowCount)throw new AppError('CONFLICT','Нет задания для повторного запуска.');return result.rows[0];
  }
  async function processJob(job:Job){
    const site=await repository.get(job.site_id);if(!site)throw new AppError('NOT_FOUND','Сайт удалён.');const domain=publicationDomain(site.domain);
    const revision=await repository.revision(job.revision_id);if(!revision||revision.siteId!==site.id)throw new AppError('NOT_FOUND','Версия не найдена.');
    const hostRow=(await pool.query("select h.*,host(h.host) host from factory.hosting_hosts h join factory.hosting_addresses a on a.host_id=h.id where a.address=$1::inet and h.status in ('ready','draining')",[job.address])).rows[0];
    if(!portsOverride&&!hostRow)throw new AppError('UNAVAILABLE','Сервер публикации не готов.');
    const host:LinuxHost=hostRow?{host:hostRow.host,port:hostRow.port,username:hostRow.username,hostFingerprint:hostRow.host_fingerprint,privateKeyEncrypted:hostRow.credential}:{} as LinuxHost;
    const ports:HostingPorts=portsOverride??{maintain:linuxMaintain,publish:(target,files)=>linuxPublish(host,target,files),dns:{read:name=>provider(job.dns_provider,domain).read(name),write:(zone,before)=>provider(job.dns_provider,domain).write(zone,before)},propagated,health:verifyHostedRelease};
    const ips=(await pool.query('select host(address) address from factory.hosting_addresses where site_id=$1 and host_id=(select host_id from factory.hosting_addresses where address=$2::inet) order by address',[site.id,job.address])).rows.map(r=>r.address as string);
    if(!ips.includes(job.address))throw new AppError('CONFLICT','Назначение IPv4 изменилось.');
    const target={siteId:site.id,revisionId:revision.id,domain,ips,order:String(job.id)};
    const phase=async(value:string)=>{job.phase=value;await pool.query('update factory.hosting_jobs set phase=$2,updated_at=now() where id=$1',[job.id,value]);};
    if(job.action==='release'){
      const binding=(await pool.query('select host(address) address,revision_id from factory.hosting_sites where site_id=$1',[site.id])).rows[0];
      if(binding?.address===job.address)throw new AppError('CONFLICT','IPv4 снова используется сайтом.');
      const assigned=(await pool.query('select state,release_after from factory.hosting_addresses where address=$1',[job.address])).rows[0];
      if(assigned?.release_after&&new Date(assigned.release_after).getTime()>Date.now())throw new AppError('CONFLICT','Срок DNS-кэша ещё не истёк.');
      const zone=await ports.dns.read(domain);
      if(zone.records.some(r=>r.Type==='A'&&r.Address===job.address))throw new AppError('CONFLICT','В DNS ещё есть ссылка на освобождаемый IPv4.');
      if(binding){if(!await ports.propagated(domain,binding.address))throw new AppError('CONFLICT','Новый IPv4 ещё не подтверждён публичными DNS.');await ports.health(domain,binding.address,binding.revision_id,true);}
      if(!ports.maintain)throw new AppError('UNAVAILABLE','Не подключён исполнитель обслуживания Linux.');
      const remaining=ips.filter(ip=>ip!==job.address);await ports.maintain(host,{...target,ips:remaining},remaining.length?'bindings':'remove');
      const tx=await pool.connect();try{await tx.query('begin');await tx.query('select pg_advisory_xact_lock(78424520)');
        await tx.query("update factory.hosting_addresses set site_id=null,state='free',release_after=null where address=$1 and site_id=$2",[job.address,site.id]);
        await tx.query("update factory.hosting_jobs set status='complete',phase='released',error=null,updated_at=now() where id=$1",[job.id]);await tx.query('commit');
      }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}return;
    }
    if(job.action==='prune'){
      const current=(await pool.query('select revision_id from factory.hosting_sites where site_id=$1',[site.id])).rows[0];
      if(!current)throw new AppError('CONFLICT','Нет опубликованной версии.');
      const keep=[...new Set([current.revision_id,...(await pool.query("select revision_id,max(id) latest from factory.hosting_jobs where site_id=$1 and status='complete' and retained and action in ('deploy','replace','migrate','rollback') group by revision_id order by latest desc limit 5",[site.id])).rows.map(r=>r.revision_id)])] as string[];
      if(!ports.maintain)throw new AppError('UNAVAILABLE','Не подключён исполнитель обслуживания Linux.');
      for(const row of (await pool.query('select distinct h.*,host(h.host) ip from factory.hosting_hosts h join factory.hosting_addresses a on a.host_id=h.id where a.site_id=$1',[site.id])).rows){
        const hostIps=(await pool.query('select host(address) ip from factory.hosting_addresses where site_id=$1 and host_id=$2',[site.id,row.id])).rows.map(a=>a.ip);
        await ports.maintain({host:row.ip,port:row.port,username:row.username,hostFingerprint:row.host_fingerprint,privateKeyEncrypted:row.credential},{...target,ips:hostIps},'prune',keep);
      }
      const tx=await pool.connect();try{await tx.query('begin');
        await tx.query("delete from private.payload_pins where id in (select revision_id from factory.hosting_jobs where site_id=$1 and not(revision_id=any($2::uuid[])))",[site.id,keep]);
        await tx.query('update factory.hosting_jobs set retained=false where site_id=$1 and not(revision_id=any($2::uuid[]))',[site.id,keep]);
        await tx.query("update factory.hosting_jobs set status='complete',phase='pruned',error=null,updated_at=now() where id=$1",[job.id]);await tx.query('commit');
      }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}return;
    }
    if(job.action==='rollback'){
      // File rollback keeps the current allocation, existing listeners and TLS
      // certificate. It never depends on DNS credentials or an ACME request.
      const binding=(await pool.query('select host(address) address from factory.hosting_sites where site_id=$1',[site.id])).rows[0];
      if(binding?.address!==job.address)throw new AppError('CONFLICT','Текущий IPv4 изменился. Откат остановлен.');
      await ports.publish(target,await store.read(revision.manifestId));
      await ports.health(domain,job.address,revision.id,false);
      const tx=await pool.connect();
      try{
        await tx.query('begin');
        await tx.query('update factory.hosting_sites set revision_id=$2,updated_at=now() where site_id=$1',[site.id,revision.id]);
        await tx.query("update factory.hosting_jobs set status='complete',phase='rolled_back',error=null,updated_at=now() where id=$1",[job.id]);
        await tx.query('commit');
      }catch(error){await tx.query('rollback');throw error;}finally{tx.release();}
      return;
    }
    if(job.phase==='upload'){
      if(!portsOverride){const preflight=await ports.dns.read(domain);mergeIPv4(preflight,job.address);if(job.dns_provider==='godaddy'&&preflight.records.filter(r=>r.Type==='A'&&r.Name==='@').length>1)throw new AppError('CONFLICT','В GoDaddy несколько A-записей корня. Оставьте одну перед подключением сайта.');}
      await ports.publish(target,await store.read(revision.manifestId));await ports.health(domain,job.address,revision.id,false,true);
      if(job.action!=='migrate')await pool.query('insert into factory.hosting_sites(site_id,address,revision_id) values($1,$2,$3) on conflict(site_id) do update set address=$2,revision_id=$3,updated_at=now()',[site.id,job.address,revision.id]);
      await phase('dns');
    }
    if(job.phase==='dns'){
      let current=await ports.dns.read(domain);
      if(!job.dns_before||!job.dns_after){job.dns_before=current;job.dns_after=mergeIPv4(current,job.address,job.dns_provider==='godaddy'?'600':'300');await pool.query('update factory.hosting_jobs set dns_before=$2,dns_after=$3 where id=$1',[job.id,job.dns_before,job.dns_after]);}
      if(zoneHash(current)!==zoneHash(job.dns_after)){
        if(zoneHash(current)!==zoneHash(job.dns_before))throw new AppError('CONFLICT','DNS изменён извне после снимка. Автоматическая перезапись остановлена.');
        // Re-read immediately before a full-zone write; preserve unrelated records.
        current=await ports.dns.read(domain);if(zoneHash(current)!==zoneHash(job.dns_before))throw new AppError('CONFLICT','DNS изменился перед записью.');
        await ports.dns.write(job.dns_after,job.dns_before);
        if(zoneHash(await ports.dns.read(domain))!==zoneHash(job.dns_after))throw new AppError('CONFLICT','DNS после записи отличается от ожидаемого. Снимок сохранён.');
      }
      await phase('propagation');
    }
    if(job.phase==='propagation'){
      if(!await ports.propagated(domain,job.address)){
        if(Date.now()-new Date(job.created_at).getTime()>86400000)throw new AppError('UNAVAILABLE','DNS не распространился за 24 часа. Проверьте A/AAAA и повторите.');
        await pool.query("update factory.hosting_jobs set status='waiting',next_attempt=now()+interval '30 seconds',updated_at=now() where id=$1",[job.id]);return;
      }
      await phase('https');
    }
    if(job.phase==='https'){await ports.publish(target);await phase('verify');}
    await ports.health(domain,job.address,revision.id,true);
    if(!await ports.propagated(domain,job.address)){
      await phase('propagation');await pool.query("update factory.hosting_jobs set status='waiting',next_attempt=now()+interval '30 seconds',updated_at=now() where id=$1",[job.id]);return;
    }
    await pool.query('insert into factory.hosting_sites(site_id,address,revision_id) values($1,$2,$3) on conflict(site_id) do update set address=$2,revision_id=$3,updated_at=now()',[site.id,job.address,revision.id]);
    const cacheSeconds=Math.max(172800,...(job.dns_before?.records??[]).filter(r=>r.Type==='A').map(r=>Number(r.TTL)).filter(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647));
    await pool.query("update factory.hosting_addresses set state=case when address=$2::inet then 'active' else 'draining' end,release_after=case when address=$2::inet then null else greatest(release_after,now()+make_interval(secs=>$3)) end where site_id=$1",[site.id,job.address,cacheSeconds]);
    await pool.query("update factory.hosting_hosts set checked_at=now() where id=$1",[hostRow?.id??'']);
    await pool.query("update factory.hosting_jobs set status='complete',phase='ready',error=null,updated_at=now() where id=$1",[job.id]);
  }
  const activeHosts=new Map<string,Promise<void>>();let selecting:Promise<void>|null=null;
  async function runHost(hostId:string){
    const tx=await pool.connect();let hostLocked=false,globalLocked=false,exclusive=false;
    try{
      hostLocked=(await tx.query('select pg_try_advisory_lock(78424524,hashtext($1)) ok',[hostId])).rows[0].ok;if(!hostLocked)return;
      const job=(await tx.query<Job>("select j.*,host(j.address) address from factory.hosting_jobs j join factory.hosting_addresses a on a.address=j.address where a.host_id=$1 and j.status in ('queued','running','waiting') and j.next_attempt<=now() order by j.id limit 1",[hostId])).rows[0];if(!job)return;
      // Pruning touches previous hosts as well: exclude other publications.
      exclusive=job.action==='prune';
      globalLocked=(await tx.query(exclusive?'select pg_try_advisory_lock(78424521) ok':'select pg_try_advisory_lock_shared(78424521) ok')).rows[0].ok;if(!globalLocked)return;
      await tx.query("update factory.hosting_jobs set status='running',error=null,updated_at=now() where id=$1",[job.id]);
      try{await processJob(job);}catch(error){
        const transient=transientPublicationError(error);
        const retries=Number((await tx.query('select retry_count from factory.hosting_jobs where id=$1',[job.id])).rows[0].retry_count);
        if(transient&&retries<5)await tx.query("update factory.hosting_jobs set status='waiting',retry_count=retry_count+1,error=$2,next_attempt=now()+make_interval(secs=>$3),updated_at=now() where id=$1",[job.id,'Временный сбой. Автоматический повтор запланирован. '+error.message,30*2**retries]);
        else await tx.query("update factory.hosting_jobs set status='failed',error=$2,updated_at=now() where id=$1",[job.id,error instanceof AppError?error.message:'Публикация прервана. Повторите задание; текущие файлы и DNS-снимки сохранены.']);
      }
    }finally{
      try{if(globalLocked)await tx.query(exclusive?'select pg_advisory_unlock(78424521)':'select pg_advisory_unlock_shared(78424521)');if(hostLocked)await tx.query('select pg_advisory_unlock(78424524,hashtext($1))',[hostId]);}finally{tx.release();}
    }
  }
  async function tick(){
    if(closed||paused||selecting)return;
    const launched:Promise<void>[]=[];
    selecting=(async()=>{
      if(!await ready())return;
      const pending=(await pool.query("select a.site_id,a.actor from factory.auto_publications a join public.sites s on s.id=a.site_id where a.status='waiting' and a.next_attempt<=now() and s.draft_id is not null and not exists(select 1 from private.jobs j where j.site_id=s.id and j.data->>'state'<>'completed') order by a.created_at limit 20")).rows;
      for(const item of pending){
        try{await enqueue({userId:item.actor,role:'admin'},item.site_id,{},true);}
        catch(error){
          if(transientPublicationError(error)||['ECONNRESET','ECONNREFUSED','57P01','40001','40P01'].includes(String((error as {code?:string})?.code))){
            await pool.query("update factory.auto_publications set status=case when retry_count<5 then 'waiting' else 'failed' end,error=case when retry_count<5 then 'Временный сбой. Автоматический повтор запланирован.' else 'Повторы исчерпаны. Проверьте подключение и повторите публикацию.' end,next_attempt=now()+make_interval(secs=>30*power(2,least(retry_count,5))::int),retry_count=retry_count+1 where site_id=$1 and status='waiting'",[item.site_id]);
          }else await pool.query("update factory.auto_publications set status='failed',error=$2 where site_id=$1 and status='waiting'",[item.site_id,error instanceof AppError?error.message:'Не удалось начать публикацию. Проверьте сервер и повторите публикацию.']);
        }
      }
      const hosts=(await pool.query("select a.host_id,min(j.id) first_job from factory.hosting_jobs j join factory.hosting_addresses a on a.address=j.address where j.status in ('queued','running','waiting') and j.next_attempt<=now() group by a.host_id order by first_job")).rows;
      for(const row of hosts){
        if(closed||paused||activeHosts.size>=4)break;
        if(activeHosts.has(row.host_id))continue;
        const work=runHost(row.host_id).finally(()=>activeHosts.delete(row.host_id));activeHosts.set(row.host_id,work);launched.push(work);
      }
    })();
    try{await selecting;}finally{selecting=null;}
    await Promise.allSettled(launched);
  }
  const timer=setInterval(()=>{void tick().catch(()=>{});},2000);
  async function drain(){await selecting;await Promise.allSettled([...activeHosts.values()]);}
  return {generationPreflight,setDomainProvider,domainProviders,createSite,prepareBatch,reserveBatchSite,canAdmitBatchSite:async(tx:SqlTransaction)=>(await batchCapacity(tx))>0,async pause(){paused=true;await drain();},resume(){paused=false;},status,jobs,configureDns,configureGoDaddy,details,enqueue,preflight,retry,tick,async close(){closed=true;clearInterval(timer);await drain();}};
}
