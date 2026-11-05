// Billable live acceptance through the application's authenticated client API.
// Publishes one previously unused, explicitly allowed pilot domain. No teardown:
// the resulting site is a normal persistent site in the user's application.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash,randomInt} from 'node:crypto';
import https from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {Pool} from 'pg';
import assert from 'node:assert/strict';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {LocalAuth} from '../dist/apps/server/src/auth.js';
import {NamecheapDns} from '../dist/apps/server/src/namecheap.js';
import {propagated,verifyHostedRelease} from '../dist/apps/server/src/hosting.js';
const domain='wunderwaffe.shop',root=resolve('.local-state/conveyor-live-'+randomUUID());await mkdir(root,{recursive:true});
const cfg=JSON.parse(await readFile('.local-state/server/config.json','utf8')),conn=JSON.parse(await readFile('.local-state/client-connection.json','utf8')),endpoint=new URL(conn.endpoint);
const pool=new Pool({host:'127.0.0.1',port:cfg.databasePort,user:'factory',database:'factory',password:await protectSecret(cfg.databasePassword,true)}),auth=new LocalAuth(pool);
let session;const report={domain,startedAt:new Date().toISOString(),passed:false,stages:[]};
const save=()=>writeFile(resolve(root,'result.json'),JSON.stringify(report,null,2));
function api(path,body){return new Promise((ok,bad)=>{
 const req=https.request({hostname:'127.0.0.1',port:endpoint.port,path,method:body?'POST':'GET',ca:conn.certificate,checkServerIdentity:(_h,cert)=>checkServerIdentity(endpoint.hostname,cert),headers:{Host:endpoint.host,cookie:'__Host-factory='+session.token,...(body?{'content-type':'application/json','x-csrf-token':session.csrf,origin:endpoint.origin}:{})},timeout:30000},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode>=400)bad(Error(value.error?.message??'Application request failed'));else ok(value);}catch(e){bad(e);}});});req.on('timeout',()=>req.destroy(Error('API timeout')));req.on('error',bad);req.end(body?JSON.stringify(body):undefined);
 });}
const command=(method,params)=>api('/api/batches/commands',{method,params});
try{
 assert.equal((await pool.query('select 1 from public.sites where domain=$1',[domain])).rowCount,0,'Acceptance domain already exists; refusing duplicate/replacement');
 assert.ok((await pool.query("select 1 from factory.hosting_addresses a join factory.hosting_hosts h on h.id=a.host_id where a.site_id is null and a.state='free' and h.status='ready'")).rowCount,'No free IPv4');
 const nc=(await pool.query("select value from factory.settings where key='namecheap'")).rows[0];const dns=new NamecheapDns(JSON.parse(await protectSecret(nc.value,true)));
 const before=await dns.read(domain);await writeFile(resolve(root,'dns-before.json'),JSON.stringify(before,null,2));
 const actor=(await pool.query('select a.id from factory.accounts a join public.memberships m on m.user_id=a.id where m.active order by a.created_at limit 1')).rows[0];session=await auth.newSession(actor.id);
 const catalog=await api('/api/catalog'),styles=catalog.styles.filter(s=>s.enabled&&!s.id.startsWith('reference-')),refs=catalog.references.filter(r=>catalog.styles.some(s=>s.enabled&&s.id==='reference-'+r.id));
 const style=styles[randomInt(styles.length)].id,reference=refs[randomInt(refs.length)].id;
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 const csv=Buffer.from('domain,about,referenceId,layoutReferenceId,mentionedUrl,mentionedDescription\n'+[domain,'An English educational concept site explaining cryptocurrency, public transaction records and basic blockchain terminology. Keep the supplied reference composition. No investment advice or invented company claims.',style,reference,'https://chinazes.space/','A related resource link supplied for this site. Invite visitors to explore it without inventing claims about its contents.'].map(quote).join(','));
 const resource=await command('resource.begin',{name:'Проверка конвейера.csv',size:csv.length,sha256:createHash('sha256').update(csv).digest('hex')});
 await command('resource.chunk',{id:resource.id,index:0,base64:csv.toString('base64')});
 const preview=await command('import.prepare',{id:resource.id});assert.equal(preview.validCount,1);report.batchId=preview.id;report.reference=reference;report.style=style;await save();
 await command('import.commit',{id:preview.id,revision:preview.revision,requestKey:randomUUID()});
 // From this point the client only observes. No retry, publish, DNS or TLS command.
 let last='';const deadline=Date.now()+25*60000;
 while(Date.now()<deadline){
  const row=(await pool.query("select s.id,s.draft_id,j.data job,host(a.address) address,a.state address_state,h.status,h.phase,h.error,h.revision_id from public.sites s join private.jobs j on j.site_id=s.id left join factory.hosting_addresses a on a.site_id=s.id left join lateral(select * from factory.hosting_jobs where site_id=s.id order by id desc limit 1) h on true where s.domain=$1",[domain])).rows[0];
  const label=(row?.job?.state??'admission')+':'+(row?.job?.stage??'')+':'+(row?.phase??'');
  if(label!==last){last=label;report.stages.push({at:new Date().toISOString(),stage:label});console.log(label);await save();}
  if(row){assert.ok(row.address,'IPv4 must be reserved before generation');report.siteId=row.id;report.address=row.address;}
  if(row?.job?.state==='needs_attention'||row?.status==='failed')throw Error(row.error??'Generation needs attention');
  if(row?.status==='complete'){
   assert.equal(row.phase,'ready');assert.equal(row.draft_id,row.revision_id);
   assert.ok(await propagated(domain,row.address));await verifyHostedRelease(domain,row.address,row.revision_id,false);await verifyHostedRelease(domain,row.address,row.revision_id,true);
   const after=await dns.read(domain);await writeFile(resolve(root,'dns-after.json'),JSON.stringify(after,null,2));
   assert.ok(after.records.some(r=>r.Name==='@'&&r.Type==='A'&&r.Address===row.address));
   const unrelated=z=>z.records.filter(r=>r.Name!=='@'||!['A','URL','URL301','FRAME','ALIAS'].includes(r.Type));assert.deepEqual(unrelated(after),unrelated(before));
   const publicResponse=await fetch('https://'+domain+'/',{signal:AbortSignal.timeout(20000)});assert.equal(publicResponse.status,200);const html=await publicResponse.text();assert.ok(html.includes('https://chinazes.space/'));assert.ok(!/\bContent \d+\b/.test(html));
   report.revision=row.revision_id;report.checks=['client batch prepare/start','IPv4 reserved before generation','server DeepSeek generation','automatic SSH upload','Namecheap A and preserved unrelated records','public DNS 1.1.1.1 and 8.8.8.8','HTTP revision','trusted HTTPS revision','public domain page and mentioned link','no further client actions'];report.passed=true;break;
  }
  await new Promise(r=>setTimeout(r,3000));
 }
 assert.ok(report.passed,'Live conveyor deadline exceeded');
}catch(error){report.error=error.message;process.exitCode=1;console.error(error.message);}
finally{report.finishedAt=new Date().toISOString();await save();if(session)await auth.logout(session.token);await pool.end();console.log(JSON.stringify({passed:report.passed,domain,report:resolve(root,'result.json')}));}
