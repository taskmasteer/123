import type {Pool} from 'pg';
import {AppError} from '../../../packages/contracts/src/model.js';
import {publicationDomain} from './hosting-policy.js';
import {sshExecute,type LinuxHost} from './linux-publisher.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {artifactMediaType,checkArtifacts} from '../../../packages/core/src/artifacts.js';
import type {R2Store} from '../../../packages/adapters/src/r2-store.js';

export async function readRemoteFiles(host:LinuxHost,siteId:string,domain:string,revisionId:string){
 publicationDomain(domain);
 const script=await readFile(join(process.env.SITE_FACTORY_INSTALL_ROOT??process.env.SITE_FACTORY_SOURCE_ROOT??process.cwd(),'scripts/linux/read-release.py'));
 const command=(host.username==='root'?'':'sudo -n ')+`python3 -c "import base64;exec(base64.b64decode('${script.toString('base64')}'))"`;
 const rows=JSON.parse(await sshExecute(host,command,JSON.stringify({siteId,domain,revisionId}),60000,undefined,15000000));
 if(!Array.isArray(rows)||rows.length>100)throw new AppError('CONFLICT','Некорректный состав удалённой версии.');
 const files=rows.map((row:{path:string;data:string})=>({path:row.path,bytes:Buffer.from(row.data,'base64'),mediaType:artifactMediaType(row.path)}));
 checkArtifacts(files);if(!files.some(f=>f.path==='index.html'&&f.bytes.length))throw new AppError('CONFLICT','Удалённая версия не содержит index.html.');return files;
}

export async function readRemoteState(host:LinuxHost,siteId:string,domain:string){
 publicationDomain(domain);
 if(!/^[a-f0-9-]{36}$/.test(siteId))throw new AppError('INVALID_INPUT','Некорректный сайт.');
 const script="import sys,json,pathlib; x=json.load(sys.stdin); p=pathlib.Path('/srv/site-factory/sites')/x['id']/'state.json'; print(p.read_text() if p.is_file() and not p.is_symlink() else 'null')";
 const command=(host.username==='root'?'':'sudo -n ')+`python3 -c "${script}"`;
 return JSON.parse(await sshExecute(host,command,JSON.stringify({id:siteId}),30000));
}

/** Only directory IDs: do not open unknown sites or inspect their domains. */
export async function readRemoteSiteIds(host:LinuxHost){
 const script="import json,pathlib,re; p=pathlib.Path('/srv/site-factory/sites'); assert not p.is_symlink() and (not p.exists() or p.is_dir()); print(json.dumps([x.name for x in p.iterdir() if re.fullmatch('[a-f0-9-]{36}',x.name)] if p.exists() else []))";
 const command=(host.username==='root'?'':'sudo -n ')+`python3 -c "${script}"`;
 const ids=JSON.parse(await sshExecute(host,command,'',30000));
 if(!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)))throw new AppError('CONFLICT','Не удалось проверить инвентарь Linux.');
 return ids as string[];
}

/** Remote monotonic fences survive an older database backup. Never discard them. */
export async function reconcileRecovery(pool:Pool,read=readRemoteState,store?:Pick<R2Store,'put'>,files=readRemoteFiles,inventory=readRemoteSiteIds){
 const known=new Set((await pool.query('select id from public.sites')).rows.map(row=>row.id));
 const hosts=(await pool.query("select *,host(host) host from factory.hosting_hosts where status in ('ready','draining','retired') order by id")).rows;
 for(const row of hosts){
  const ids=await inventory({host:row.host,port:row.port,username:row.username,hostFingerprint:row.host_fingerprint,privateKeyEncrypted:row.credential});
  if(ids.some(id=>!known.has(id)))throw new AppError('CONFLICT','На Linux есть сайты, отсутствующие в резервной копии. Используйте более новую копию или восстановите инвентарь до возобновления. Их адреса не будут переиспользованы.');
 }
 const rows=(await pool.query(`select s.site_id,b.domain,b.owner_id,s.revision_id,host(s.address) address,array(select host(a2.address) from factory.hosting_addresses a2 where a2.site_id=s.site_id) allocated_ips,(select max(j.id) from factory.hosting_jobs j where j.site_id=s.site_id and j.status='complete') last_order,h.* from factory.hosting_sites s join public.sites b on b.id=s.site_id join factory.hosting_addresses a on a.address=s.address join factory.hosting_hosts h on h.id=a.host_id order by s.site_id`)).rows;
 let high=0n;
 for(const row of rows){
  const domain=publicationDomain(row.domain);
  const host={host:row.host,port:row.port,username:row.username,hostFingerprint:row.host_fingerprint,privateKeyEncrypted:row.credential};
  const state=await read(host,row.site_id,domain);
  if(!state||state.siteId!==row.site_id||state.domain!==domain||!/^\d{1,18}$/.test(String(state.order))||!Array.isArray(state.ips)||!state.ips.includes(row.address)||state.ips.some((ip:unknown)=>!(row.allocated_ips??[row.address]).includes(ip)))throw new AppError('CONFLICT',`Восстановление остановлено: состояние ${domain} на Linux отличается от резервной копии. Проверьте IP и актуальную копию.`);
  const order=BigInt(state.order);if(row.last_order&&order<BigInt(row.last_order))throw new AppError('CONFLICT',`Состояние ${domain} на Linux старее резервной копии. Проверьте восстановление сервера сайтов.`);if(order>high)high=order;
  if(state.revisionId!==row.revision_id){
   if(!store||!/^[a-f0-9-]{36}$/.test(state.revisionId))throw new AppError('CONFLICT',`На ${domain} опубликована более новая версия. Используйте актуальную резервную копию до возобновления конвейера.`);
   const manifest=await store.put(row.site_id,await files(host,row.site_id,domain,state.revisionId),'recovered-linux-release');
   const current=await read(host,row.site_id,domain);
   if(JSON.stringify(current)!==JSON.stringify(state))throw new AppError('CONFLICT','Удалённая версия изменилась во время сверки. Повторите восстановление.');
   const tx=await pool.connect();try{
    await tx.query('begin');
    const existing=(await tx.query('select site_id,manifest_id from public.revisions where id=$1',[state.revisionId])).rows[0];
    if(existing&&existing.site_id!==row.site_id)throw new AppError('CONFLICT','Идентификатор версии принадлежит другому сайту.');
    if(!existing)await tx.query("insert into public.revisions(id,site_id,parent_id,manifest_id,kind,created_at) values($1,$2,$3,$4,'draft',$5)",[state.revisionId,row.site_id,row.revision_id,manifest.id,Date.now()]);
    await tx.query("insert into private.payload_pins(id,kind,payload_id,expires_at) values($1,'artifact',$2,'infinity') on conflict do nothing",[state.revisionId,existing?.manifest_id??manifest.id]);
    // Preserve imported releases in publication history so future rollback and retention can see them.
    const collision=(await tx.query('select site_id,revision_id from factory.hosting_jobs where id=$1',[state.order])).rows[0];
    if(collision&&(collision.site_id!==row.site_id||collision.revision_id!==state.revisionId))throw new AppError('CONFLICT','Порядок удалённой публикации конфликтует с резервной копией.');
    if(!collision)await tx.query("insert into factory.hosting_jobs(id,site_id,revision_id,address,action,status,phase,actor) overriding system value values($1,$2,$3,$4,'deploy','complete','ready',$5)",[state.order,row.site_id,state.revisionId,row.address,row.owner_id]);
    await tx.query('update factory.hosting_sites set revision_id=$2,updated_at=now() where site_id=$1',[row.site_id,state.revisionId]);
    await tx.query('update public.sites set revision=revision+1,draft_id=case when draft_id is null or draft_id=$3 then $2 else draft_id end where id=$1',[row.site_id,state.revisionId,row.revision_id]);
    await tx.query("insert into factory.audit(action) values('recovery.remote-release.import')");await tx.query('commit');
   }catch(e){await tx.query('rollback');throw e;}finally{tx.release();}
  }
 }
 await pool.query(`select setval(pg_get_serial_sequence('factory.hosting_jobs','id'),greatest(nextval(pg_get_serial_sequence('factory.hosting_jobs','id')),coalesce((select max(id) from factory.hosting_jobs),1),$1::bigint),true)`,[high.toString()]);
 return {checked:rows.length,order:high.toString()};
}
