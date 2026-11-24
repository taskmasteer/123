import {_electron} from 'playwright';
import {createServer} from 'node:https';
import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {protectSecret} from '../dist/apps/server/src/secrets.js';
const root=resolve('.'),dir=resolve('.local-state/connection-smoke-'+randomUUID()),stage=join(dir,'client');await mkdir(stage,{recursive:true});
for(const f of ['main.mjs','release-signature.mjs','release-key.pem','preload.cjs','connection.mjs','connection-file.mjs','package.json'])await cp(join(root,'apps/client',f),join(stage,f));await cp(join(root,'apps/desktop/dist-web'),join(stage,'ui'),{recursive:true});
const config=JSON.parse(await readFile('.local-state/server/config.json','utf8')),cert={pfx:Buffer.from(await protectSecret(config.tlsPfx,true),'base64'),passphrase:await protectSecret(config.tlsPassword,true)};
const requests=[];const server=createServer(cert,(req,res)=>{requests.push({path:req.url,cookie:req.headers.cookie});res.setHeader('content-type','application/json');if(req.url==='/auth/status')res.end(JSON.stringify({user:null,bootstrap:false}));else if(req.url==='/auth/login'){res.setHeader('set-cookie','__Host-factory=fixture-old-session; Secure; HttpOnly');res.end('{}');}else{res.statusCode=401;res.end(JSON.stringify({error:{message:'Войдите'}}));}});
await new Promise(r=>server.listen(9445,'127.0.0.1',r));
const endpoint=new URL(config.publicOrigin);endpoint.port='9445';const profile={endpoint:endpoint.origin,certificate:config.certificate,fingerprint:config.fingerprint};const file=join(dir,'server.sfconnection');await writeFile(file,JSON.stringify(profile));
const bad=join(dir,'bad.json');await writeFile(bad,JSON.stringify({...profile,fingerprint:'invalid'}));
const unavailable=join(dir,'unavailable.sfconnection');endpoint.port='9446';await writeFile(unavailable,JSON.stringify({...profile,endpoint:endpoint.origin}));
let client,page;const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
async function launch(){client=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[stage,'--user-data-dir='+join(dir,'profile')],env});page=await client.firstWindow();page.setDefaultTimeout(35000);await page.getByRole('button',{name:'Изменить сервер — импорт файла',exact:true}).waitFor();}
async function choose(path,cancel=false){await client.evaluate(({dialog},v)=>{dialog.showOpenDialog=async()=>({canceled:v.cancel,filePaths:v.cancel?[]:[v.path]});dialog.showMessageBox=async()=>({response:0});},{path,cancel});await page.getByRole('button',{name:'Изменить сервер — импорт файла',exact:true}).click();}
try{
 await launch();await page.getByText('Сервер: не выбран',{exact:true}).waitFor();await choose(bad);await page.getByRole('alert').filter({hasText:'Certificate fingerprint mismatch'}).waitFor();assert.equal(await page.evaluate(()=>window.factoryDesktop.endpoint),'');
 await choose(file);await page.getByText('Сервер: '+profile.endpoint,{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.factoryDesktop.endpoint),profile.endpoint);assert.ok(requests.every(r=>!r.cookie));
 await page.evaluate(async()=>window.factoryDesktop.request('/auth/login','POST',{login:'fixture'}));requests.length=0;
 await choose(file);await page.getByText('Сервер: '+profile.endpoint,{exact:true}).waitFor();await page.waitForTimeout(500);assert.ok(requests.every(r=>!r.cookie),'Probe and new session must not carry old credentials');
 const stored=await client.evaluate(({app})=>app.getPath('userData'));assert.equal(JSON.parse(await readFile(join(stored,'server-connection.json'),'utf8')).endpoint,profile.endpoint);
 await choose(unavailable);await page.getByRole('alert').waitFor();assert.equal(JSON.parse(await readFile(join(stored,'server-connection.json'),'utf8')).endpoint,profile.endpoint);
 await choose(file,true);assert.equal(await page.evaluate(()=>window.factoryDesktop.endpoint),profile.endpoint);
 await page.screenshot({path:join(dir,'connection.png')});await client.close();client=null;await launch();await page.getByText('Сервер: '+profile.endpoint,{exact:true}).waitFor();await page.getByLabel('Логин',{exact:true}).waitFor();console.log('Native import passed: missing/offline configuration, invalid certificate, isolated probe, cleared cookies, persistent connection, canceled import, restart.');
}finally{await client?.close();await new Promise(r=>server.close(r));console.log('Evidence: '+dir);}
