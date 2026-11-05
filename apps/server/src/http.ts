import {createSiteUpload} from './site-upload.js';
import { createServer } from 'node:http';
import {createServer as createHttpsServer,type ServerOptions} from 'node:https';
import { readFile, stat,open } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { AppError } from '../../../packages/contracts/src/model.js';
import {clientRelease} from './client-release.js';
import {jobDiagnostic} from './job-diagnostic.js';
import { parseSiteInput } from '../../../packages/contracts/src/inputs.js';
import { normalizeDomain } from '../../../packages/core/src/sites.js';
import { readMentionedPage } from './link-reader.js';
import { downloadSource } from './download.js';
import { uuid,integer,siteView } from '../../../packages/contracts/src/http.js';
import type { ServerRuntime } from './runtime.js';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export function createHttpHandler(runtime:ServerRuntime,origin:string,webRoot:string,serveInterface=true){
  const uploadSite=createSiteUpload(runtime);
  const secure=origin.startsWith('https:'),cookieName=secure?'__Host-factory':'factory';
  const cookie=(token:string,age=43200)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
  const handle=async(request:Request,remote='127.0.0.1'):Promise<Response>=>{
    const url=new URL(request.url),path=url.pathname;
    const raw=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1)??'';
    try{
      if(url.origin!==origin)throw new AppError('FORBIDDEN','Неверный адрес панели.');
      if(request.method!=='GET'&&request.method!=='HEAD'&&request.headers.get('origin')!==origin)throw new AppError('FORBIDDEN','Недопустимый источник запроса.');
      // Preview is independently authorized by expiring, revision-bound capabilities.
      // Its opaque sandbox origin must never need the application session cookie.
      if(path.startsWith('/preview/')&&request.method==='GET')return runtime.app(request);
      const parse=async()=>{if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('INVALID_INPUT','Требуется JSON.');try{return JSON.parse(await request.text());}catch{throw new AppError('INVALID_INPUT','Некорректный JSON.');}};
      if(path==='/auth/status'&&request.method==='GET'){
        let user=await runtime.auth.session(raw);let testToken:string|undefined;
        const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote);
        if(!user&&local){
          let setting:{enabled?:boolean;userId?:string}={};
          try{setting=JSON.parse(await readFile(resolve(runtime.dataRoot,'test-login.json'),'utf8'));}catch{}
          if(setting.enabled===true&&typeof setting.userId==='string'&&/^[a-f0-9-]{36}$/.test(setting.userId)){
            const account=(await runtime.pool.query('select a.id from factory.accounts a join public.memberships m on m.user_id=a.id where a.id=$1 and m.active',[setting.userId])).rows[0];
            if(account){const session=await runtime.auth.newSession(account.id);testToken=session.token;user=await runtime.auth.session(session.token);await runtime.auth.audit(account.id,'account.local-test-login');}
          }
        }
        const response=json({user,bootstrap:await runtime.auth.bootstrapAvailable()&&local});if(testToken)response.headers.set('set-cookie',cookie(testToken));return response;
      }
      if(path==='/auth/invitation'&&request.method==='POST'){
        await runtime.auth.limit('invite-ip:'+remote,30);const body=await parse();return json(await runtime.auth.checkInvite(body.code));
      }
      if(['/auth/login','/auth/register'].includes(path)&&request.method==='POST'){
        await runtime.auth.limit('ip:'+remote,30);const body=await parse();
        const session=path==='/auth/login'?await runtime.auth.login(body.login,body.password):await runtime.auth.register(body,['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote));
        const response=json({user:await runtime.auth.session(session.token)});response.headers.set('set-cookie',cookie(session.token));return response;
      }
      if(path.startsWith('/api/')||path==='/auth/logout'||path.startsWith('/preview/')){
        const session=await runtime.auth.session(raw);
        if(path==='/auth/logout'&&request.method==='POST'&&!session){const response=json({ok:true});response.headers.set('set-cookie',cookie('',0));return response;}
        if(!session)throw new AppError('UNAUTHENTICATED','Войдите в систему.');
        if(/^\/api\/sites\/[^/]+\/(?:edits|candidates|visual|chat)(?:\/|$)/.test(path))throw new AppError('FORBIDDEN','Редактирование сайтов отключено.');
        const referencePreview=/^\/api\/reference-preview\/([a-z-]+)$/.exec(path);
        const diagnosticRoute=/^\/api\/sites\/([^/]+)\/diagnostic$/.exec(path);
        if(diagnosticRoute&&request.method==='GET'){
          const actor=await runtime.auth.verifyUser(raw),id=uuid(diagnosticRoute[1]);await runtime.repository.scoped(actor,id);
          const job=await runtime.repository.current(id);
          const saved=job?.checkpointId&&['needs_attention','waiting_provider','paused'].includes(job.state)?await runtime.store.load(job.checkpointId):null;
          return json(jobDiagnostic(job,saved?.state));
        }
        if(referencePreview&&request.method==='GET'){
          const catalog=await runtime.catalog.list();if(!catalog.references.some(r=>r.id===referencePreview[1]))throw new AppError('NOT_FOUND','Референс не найден.');
          try{const bytes=await readFile(resolve(process.env.SITE_FACTORY_SOURCE_ROOT??'.','references/previews',referencePreview[1]+'.jpg'));return json({image:'data:image/jpeg;base64,'+bytes.toString('base64'),ready:catalog.styles.some(s=>s.id==='reference-'+referencePreview[1]&&s.enabled)});}catch{return json({image:null,ready:false});}
        }
        if(path==='/api/client-release'&&request.method==='GET')return json(await clientRelease(process.env.SITE_FACTORY_INSTALL_ROOT??'.'));
        const updateChunk=/^\/api\/client-release\/([a-f0-9]{64})$/.exec(path);
        if(updateChunk&&request.method==='GET')return new Response(await clientRelease(process.env.SITE_FACTORY_INSTALL_ROOT??'.',updateChunk[1],Number(url.searchParams.get('offset'))),{headers:{'content-type':'application/octet-stream','cache-control':'no-store'}});
        if(!['GET','HEAD'].includes(request.method)&&request.headers.get('x-csrf-token')!==session.csrf)throw new AppError('FORBIDDEN','Обновите страницу и повторите.');
        const uploadRoute=/^\/api\/sites\/([^/]+)\/upload$/.exec(path);
        if(uploadRoute&&request.method==='POST')return json(await uploadSite(await runtime.auth.verifyUser(raw),uuid(uploadRoute[1]),await parse()));
        if(path==='/api/recovery'&&request.method==='GET')return json({...runtime.recoveryState(),backups:await runtime.recovery.list()});
        if(path==='/api/recovery/resume'&&request.method==='POST'){await runtime.resumeRecovery();await runtime.auth.audit(session.id,'recovery.resume');return json({ok:true});}
        if(path==='/api/recovery/backups'&&request.method==='POST'){const result=await runtime.recovery.create();await runtime.auth.audit(session.id,'backup.create');return json(result,202);}
        if(path==='/api/recovery/key'&&request.method==='POST'){await runtime.auth.audit(session.id,'backup.key.export');return json({key:await runtime.recovery.key()});}
        const backup=/^\/api\/recovery\/backups\/([a-f0-9-]{36})\/(info|chunk)$/.exec(path);
        if(backup&&request.method==='GET'){
          const saved=await runtime.recovery.file(uuid(backup[1]));const size=(await stat(saved.path)).size;
          if(backup[2]==='info')return json({size});
          const offset=integer(Number(url.searchParams.get('offset')??0),0,size),file=await open(saved.path,'r');
          try{const bytes=Buffer.alloc(Math.min(1024*1024,size-offset));if((await file.read(bytes,0,bytes.length,offset)).bytesRead!==bytes.length)throw new Error('Truncated backup');return new Response(bytes,{headers:{'content-type':'application/octet-stream','cache-control':'no-store'}});}finally{await file.close();}
        }
        const health=/^\/api\/sites\/([^/]+)\/health$/.exec(path);
        if(health&&request.method==='POST'){await runtime.repository.scoped(await runtime.auth.verifyUser(raw),uuid(health[1]),'site:publish');await runtime.monitoring.request(health[1]!);return json({ok:true},202);}
        if(path==='/api/servers'&&request.method==='GET')return json(await runtime.servers.list());
        if(path==='/api/servers'&&request.method==='POST'){const result=await runtime.servers.add(await parse());await runtime.auth.audit(session.id,'server.add');return json(result,202);}
        const serverMaintenance=/^\/api\/servers\/([a-zA-Z0-9-]+)\/maintenance$/.exec(path);
        if(serverMaintenance&&request.method==='POST'){const body=await parse(),result=await runtime.servers.maintain(serverMaintenance[1]!,body);await runtime.auth.audit(session.id,'server.maintenance.'+String(body.action));return json(result,202);}
        const serverCredentials=/^\/api\/servers\/([a-zA-Z0-9-]+)\/credentials$/.exec(path);
        if(serverCredentials&&request.method==='POST'){const result=await runtime.servers.credentials(serverCredentials[1]!,await parse());await runtime.auth.audit(session.id,'server.credentials');return json(result,202);}
        const serverRetry=/^\/api\/servers\/([a-zA-Z0-9-]+)\/retry$/.exec(path);
        if(serverRetry&&request.method==='POST'){const result=await runtime.servers.retry(serverRetry[1]!);await runtime.auth.audit(session.id,'server.retry');return json(result,202);}
        if(path==='/api/settings/godaddy'&&request.method==='POST'){const body=await parse();await runtime.hosting.configureGoDaddy(body.token);await runtime.auth.audit(session.id,'godaddy.configure');return json({ok:true});}
        if(path==='/api/hosting'&&request.method==='GET')return json(await runtime.hosting.status());
        if(path==='/api/hosting/jobs'&&request.method==='GET')return json(await runtime.hosting.jobs());
        if(path==='/api/settings/namecheap'&&request.method==='POST'){
          const body=await parse();await runtime.hosting.configureDns(body);await runtime.auth.audit(session.id,'namecheap.configure');return json({ok:true});
        }
        const preflight=/^\/api\/sites\/([^/]+)\/hosting\/preflight$/.exec(path);
        if(preflight&&request.method==='POST'){const body=await parse();return json(await runtime.hosting.preflight(await runtime.auth.verifyUser(raw),uuid(preflight[1]),body.excluded??[]));}
        const hosting=/^\/api\/sites\/([^/]+)\/hosting(?:\/(retry))?$/.exec(path);
        if(hosting){
          const actor=await runtime.auth.verifyUser(raw),id=uuid(hosting[1]);await runtime.repository.scoped(actor,id,'site:publish');
          if(request.method==='GET'&&!hosting[2])return json(await runtime.hosting.details(id));
          if(request.method==='POST'){
            const result=hosting[2]?await runtime.hosting.retry(actor,id):await runtime.hosting.enqueue(actor,id,await parse());
            await runtime.auth.audit(session.id,'hosting.'+(hosting[2]??'enqueue'));return json(result,202);
          }
        }
        const download=/^\/api\/sites\/([^/]+)\/download$/.exec(path);
        if(download&&request.method==='GET')return await downloadSource(runtime,raw,download[1]!,url);
        const revisions=/^\/api\/sites\/([^/]+)\/draft-history$/.exec(path);
        if(revisions&&request.method==='GET'){
          const id=uuid(revisions[1]),actor=await runtime.auth.verifyUser(raw),site=await runtime.repository.scoped(actor,id);
          const offset=integer(Number(url.searchParams.get('offset')??0),0,100000);
          const rows=(await runtime.pool.query(`with recursive chain as (
            select r.*,0 as depth from public.revisions r where r.id=$2 and r.site_id=$1
            union all select r.*,c.depth+1 from public.revisions r join chain c on r.id=c.parent_id where r.site_id=$1 and c.depth<10000
          ) select id,created_at,depth from chain order by depth limit 21 offset $3`,[id,site.draftId,offset])).rows;
          return json({items:rows.slice(0,20).map(r=>({id:r.id,createdAt:Number(r.created_at),current:r.depth===0})),nextOffset:rows.length>20?offset+20:null});
        }
        if(path==='/auth/logout'&&request.method==='POST'){await runtime.auth.logout(raw);const response=json({ok:true});response.headers.set('set-cookie',cookie('',0));return response;}
        if(path==='/api/settings/model'){
          if(request.method==='GET')return json(runtime.status());
          if(request.method==='POST'){const body=await parse();await runtime.configure(body.apiKey);await runtime.auth.audit(session.id,'model.configure');return json(runtime.status());}
        }
        if(path==='/api/accounts'&&request.method==='GET')return json((await runtime.pool.query('select a.id,a.login,m.active from factory.accounts a join public.memberships m on m.user_id=a.id order by a.login')).rows);
        if(path==='/api/invitations'&&request.method==='POST'){const body=await parse();return json(await runtime.auth.invite(session.id,body.login));}
        if(path==='/api/accounts/status'&&request.method==='POST'){
          const body=await parse();if(body.id===session.id||typeof body.active!=='boolean')throw new AppError('INVALID_INPUT','Собственный доступ отключить нельзя.');
          await runtime.pool.query('update public.memberships set active=$2 where user_id=$1',[body.id,body.active]);if(!body.active)await runtime.pool.query('delete from factory.sessions where user_id=$1',[body.id]);await runtime.auth.audit(session.id,'account.status');return json({ok:true});
        }
        if(path==='/api/jobs'&&request.method==='GET')return json((await runtime.pool.query("select j.data,s.domain,s.input from private.jobs j join public.sites s on s.id=j.site_id order by j.id desc limit 100")).rows);
        let body:unknown=undefined;
        if(!['GET','HEAD'].includes(request.method))body=await parse();
        if(path==='/api/sites'&&request.method==='POST'){
          if(!runtime.status().configured)throw new AppError('UNAVAILABLE','Сначала сохраните ключ DeepSeek в настройках.');
          const input=parseSiteInput(body);normalizeDomain(input.domain);
          if(!input.mentionedUrl?.trim())throw new AppError('INVALID_INPUT','Укажите обязательную упоминаемую ссылку.');
          if(input.layoutReferenceId){const catalog=await runtime.catalog.list();if(!catalog.references.some(r=>r.id===input.layoutReferenceId)||!catalog.styles.some(s=>s.id==='reference-'+input.layoutReferenceId&&s.enabled))throw new AppError('INVALID_INPUT','Этот референс недоступен для генерации.');}
          if(input.mentionedUrl&&!input.mentionedDescription?.trim()){
            try{input.mentionedDescription=await readMentionedPage(input.mentionedUrl);}catch(error){if(error instanceof AppError)throw error;throw new AppError('INVALID_INPUT','Страницу ссылки прочитать не удалось. Добавьте пояснение в поле под ссылкой.');}
          }
          const site=await runtime.hosting.createSite(await runtime.auth.verifyUser(raw),input);
          await runtime.auth.audit(session.id,'site.create-and-publish');
          return json(siteView({...site,job:null}));
        }
        // Native device/admin capability endpoints are intentionally absent from this web host.
        const target=path.startsWith('/api/')?path.slice(4):path;
        if(/^\/(?:worker|uploads|admin)(?:\/|$)/.test(target))throw new AppError('FORBIDDEN','Маршрут недоступен в панели.');
        if(target.endsWith('/jobs/retry'))body={modelIdentity:'deepseek:deepseek-flash'};
        const headers=new Headers({'authorization':'Bearer '+raw,'content-type':'application/json','origin':origin});
        if(request.headers.get('cookie'))headers.set('cookie',request.headers.get('cookie')!);
        const response=await runtime.app(new Request(origin+target+url.search,{method:request.method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})}));
        if(path.startsWith('/preview/')){response.headers.set('cache-control','no-store');}
        if(!['GET','HEAD'].includes(request.method)&&response.ok)await runtime.auth.audit(session.id,request.method+' '+target);
        return response;
      }
      if(!serveInterface||request.method!=='GET'&&request.method!=='HEAD')return json({error:{message:'Маршрут не найден.'}},404);
      const asset=path==='/'?'web.html':decodeURIComponent(path.slice(1));
      let file=resolve(webRoot,asset);if(!file.startsWith(resolve(webRoot)+sep))return new Response(null,{status:404});
      try{if(!(await stat(file)).isFile())throw new Error();}catch{if(path.startsWith('/assets/'))return new Response(null,{status:404});file=resolve(webRoot,'web.html');}
      const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
      return new Response(await readFile(file),{headers:{'content-type':mime[extname(file)]??'application/octet-stream','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'cache-control':'no-cache'}});
    }catch(error){const code=error instanceof AppError?error.code:'UNAVAILABLE';const status=code==='UNAUTHENTICATED'?401:code==='FORBIDDEN'?403:code==='INVALID_INPUT'?400:code==='CONFLICT'?409:code==='NOT_FOUND'?404:503;return json({error:{code,message:error instanceof AppError?error.message:'Операция не выполнена. Повторите позже.'}},status);}
  };
  return async(request:Request,remote='127.0.0.1'):Promise<Response>=>{
    if(new URL(request.url).pathname==='/api/recovery')return handle(request,remote);
    try{return await runtime.gate.request(()=>handle(request,remote));}
    catch(e){return json({error:{code:'UNAVAILABLE',message:e instanceof AppError?e.message:'Обслуживание сервера.'}},503);}
  };
}
export function createNodeServer(handler:ReturnType<typeof createHttpHandler>,origin:string,tls?:ServerOptions){
  const listener:import('node:http').RequestListener=async(req,res)=>{
    try{
      if(req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return;}
      let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>64000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const request=new Request(origin+(req.url??'/'),{method:req.method??'GET',headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
      const response=await handler(request,req.socket.remoteAddress);res.statusCode=response.status;
      response.headers.forEach((value,key)=>res.setHeader(key,value));res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500);res.end('Request failed');}
  };
  return tls?createHttpsServer(tls,listener):createServer(listener);
}
