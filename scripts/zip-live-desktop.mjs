// Explicitly opt-in: exercises the installed client against the live publication service.
// Reuploads one existing site's files with an invisible marker, then restores its original release.
import './lib/browser-env.mjs';
import {_electron} from 'playwright';
import {Pool} from 'pg';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {zipSync,unzipSync,strToU8} from 'fflate';
import assert from 'node:assert/strict';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
import {verifyHostedRelease,propagated} from '../dist/apps/server/src/hosting.js';
import {NamecheapDns,zoneHash} from '../dist/apps/server/src/namecheap.js';

if(process.env.SITE_FACTORY_LIVE_ZIP!=='1')throw Error('Live acceptance requires explicit opt-in.');
const domain='chinazes.space',run=randomUUID(),directory=resolve('.local-state/zip-live-'+run);
await mkdir(directory,{recursive:true});
const cfg=JSON.parse(await readFile('.local-state/server/config.json','utf8'));
const pool=new Pool({host:'127.0.0.1',port:cfg.databasePort,user:'factory',database:'factory',password:await protectSecret(cfg.databasePassword,true)});
const report={domain,startedAt:new Date().toISOString(),passed:false,stages:[],errors:[]};
let client,page,before,newRevision;
const save=()=>writeFile(resolve(directory,'result.json'),JSON.stringify(report,null,2));
const stage=async(name,data={})=>{report.stages.push({at:new Date().toISOString(),name,...data});await save();console.log(name);};
const snapshot=async()=>(await pool.query("select s.id,s.draft_id,h.revision_id,host(h.address) address from public.sites s join factory.hosting_sites h on h.site_id=s.id where s.domain=$1",[domain])).rows[0];
async function waitPublication(action,revision){
 const deadline=Date.now()+240000;let last='';
 while(Date.now()<deadline){
  const job=(await pool.query('select id,status,phase,error from factory.hosting_jobs where site_id=$1 and action=$2 and revision_id=$3 order by id desc limit 1',[before.id,action,revision])).rows[0];
  const state=job?job.status+':'+job.phase:'pending';if(state!==last){last=state;console.log(action+' '+state);}
  if(job?.status==='failed')throw Error(job.error??'Publication failed');
  if(job?.status==='complete')return job;
  await new Promise(r=>setTimeout(r,2000));
 }throw Error('Publication timeout');
}
async function rollback(){
 const details=page.locator('details.hosting-details');
 if(!await details.evaluate(e=>e.open))await details.locator('summary').click();
 const row=details.locator('.hosting-history').filter({hasText:before.revision_id.slice(0,8)});
 await row.getByRole('button',{name:'Откатить',exact:true}).click();
 await waitPublication('rollback',before.revision_id);
 const current=await snapshot();assert.equal(current.revision_id,before.revision_id);assert.equal(current.address,before.address);
 await verifyHostedRelease(domain,before.address,before.revision_id,false);await verifyHostedRelease(domain,before.address,before.revision_id,true);
 return current;
}
try{
 before=await snapshot();assert.ok(before);assert.equal(before.draft_id,before.revision_id,'Do not overwrite unpublished work');
 assert.equal((await pool.query("select count(*)::int n from factory.hosting_jobs where site_id=$1 and status in ('queued','running','waiting')",[before.id])).rows[0].n,0);
 assert.equal((await pool.query("select count(*)::int n from private.jobs where site_id=$1 and data->>'state' in ('queued','running','waiting_provider')",[before.id])).rows[0].n,0);
 report.before=before;await verifyHostedRelease(domain,before.address,before.revision_id,true);
 const nc=(await pool.query("select value from factory.settings where key='namecheap'")).rows[0];const dns=new NamecheapDns(JSON.parse(await protectSecret(nc.value,true))),zoneBefore=await dns.read(domain);await writeFile(resolve(directory,'dns-before.json'),JSON.stringify(zoneBefore,null,2));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 client=await _electron.launch({executablePath:resolve('.local-state/releases/Site Factory-win32-x64/Site Factory.exe'),env,timeout:30000});
 page=await client.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.getByRole('heading',{name:'Ваши сайты',exact:true}).waitFor();assert.equal(page.url(),'factory://app/');
 report.clientVersion=await page.evaluate(()=>window.factoryDesktop.version);await stage('installed-client-opened');
 await page.getByRole('button',{name:'Задания',exact:true}).click();await page.getByRole('tab',{name:'Очередь',exact:true}).click();
 const cells=page.locator('[data-slot=tabs-content][data-state=active] tbody tr td:last-child');await cells.first().waitFor();assert.equal(await cells.locator('svg.lucide-check').count(),0);
 await page.screenshot({path:resolve(directory,'01-queue.png'),fullPage:true});await stage('queue-action-checkmarks-removed');
 await page.getByRole('button',{name:'Сайты',exact:true}).click();await page.getByRole('button',{name:'Настройки '+domain,exact:true}).click();
 await page.getByText('Сайт опубликован',{exact:true}).waitFor();
 const originalZip=resolve(directory,'original.zip');
 // Automate only the native save-path choice; the app's download IPC and production TLS stay real.
 await client.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},originalZip);
 await page.getByRole('button',{name:'Скачать ZIP исходников',exact:true}).click();await page.getByText('Выбор места сохранения завершён.',{exact:true}).waitFor();
 const original=await readFile(originalZip),files=unzipSync(original);assert.ok(files['index.html']);report.originalZipSha256=createHash('sha256').update(original).digest('hex');
 const originalHtml=Buffer.from(files['index.html']);report.originalHtmlSha256=createHash('sha256').update(originalHtml).digest('hex');
 const marker='site-factory-zip-check:'+run;files['index.html']=Buffer.concat([originalHtml,strToU8('\n<!-- '+marker+' -->\n')]);
 const updateZip=resolve(directory,'update.zip');await writeFile(updateZip,zipSync(files));await stage('original-downloaded-and-update-prepared',{bytes:(await stat(updateZip)).size});
 await page.getByLabel('Архив новой версии',{exact:true}).setInputFiles(updateZip);await page.getByText('Новая версия сохранена.',{exact:false}).waitFor();
 newRevision=(await snapshot()).draft_id;assert.notEqual(newRevision,before.revision_id);report.newRevision=newRevision;
 assert.equal((await snapshot()).revision_id,before.revision_id,'Uploading must not publish automatically');await stage('zip-uploaded-through-desktop',{revision:newRevision});
 await page.screenshot({path:resolve(directory,'02-upload.png'),fullPage:true});await page.getByRole('button',{name:'Опубликовать обновление',exact:true}).click();
 await waitPublication('deploy',newRevision);const published=await snapshot();assert.equal(published.address,before.address);assert.equal(published.revision_id,newRevision);
 await verifyHostedRelease(domain,before.address,newRevision,false);await verifyHostedRelease(domain,before.address,newRevision,true);assert.ok(await propagated(domain,before.address));
 const response=await fetch('https://'+domain+'/?zip-check='+run,{signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);assert.ok((await response.text()).includes(marker));
 await stage('live-update-verified',{address:published.address,http:true,https:true,dns:true});await page.screenshot({path:resolve(directory,'03-published.png'),fullPage:true});
 report.after=await rollback();await stage('live-rollback-verified',{address:report.after.address,revision:report.after.revision_id});
 const restored=await fetch('https://'+domain+'/?rollback-check='+run,{signal:AbortSignal.timeout(20000)});assert.equal(restored.status,200);const restoredBytes=Buffer.from(await restored.arrayBuffer());assert.equal(createHash('sha256').update(restoredBytes).digest('hex'),report.originalHtmlSha256);
 const zoneAfter=await dns.read(domain);await writeFile(resolve(directory,'dns-after.json'),JSON.stringify(zoneAfter,null,2));assert.equal(zoneHash(zoneAfter),zoneHash(zoneBefore),'DNS zone must stay unchanged');
 await page.screenshot({path:resolve(directory,'04-rollback.png'),fullPage:true});assert.deepEqual(report.errors,[]);report.passed=true;await stage('passed-original-content-and-dns-restored');
}catch(error){
 report.failure=error.message;await save();await page?.screenshot({path:resolve(directory,'failure.png'),fullPage:true}).catch(()=>{});
 // If a release changed before a later assertion failed, restore it through the same UI.
 if(before&&page&&(await snapshot())?.revision_id!==before.revision_id){try{await rollback();await stage('recovery-rollback-complete');}catch(e){report.recoveryError=e.message;await save();}}
 throw error;
}finally{await save();await client?.close();await pool.end();console.log('Evidence: '+directory);}
