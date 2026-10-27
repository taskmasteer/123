import {AppError} from '../../../../packages/contracts/src/model.js';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {object,uuid,integer,string,siteView} from '../../../../packages/contracts/src/http.js';
import type {SessionView} from '../../../../packages/contracts/src/http.js';
const bad=():never=>{throw new AppError('INVALID_INPUT','Некорректный ответ сервера.');};
function list(value:unknown){if(!Array.isArray(value)||value.length>10000)return bad();return value;}
export function sessionView(value:unknown):SessionView {const s=object(value,['principal','mode','capabilities']),p=object(s.principal,['userId','role']),c=object(s.capabilities,['admin','edit','generation','publish','export','preview','nativeModelSettings']);uuid(p.userId);if(!['user','spec-user','admin'].includes(String(p.role))||s.mode!=='managed'||Object.keys(c).length!==7||Object.values(c).some(v=>typeof v!=='boolean')||c.nativeModelSettings!==false||c.generation!==false||c.publish!==false||c.export!==false)return bad();return s as unknown as SessionView;}
function validate(method:string,value:unknown):unknown {
 if(method==='session')return sessionView(value);
 if(method==='site.list'){const p=object(value,['items','nextCursor']);if(p.nextCursor!==null)uuid(p.nextCursor);return {items:list(p.items).map(siteView),nextCursor:p.nextCursor};}
 if(method==='site.create'||method==='edit.accept')return siteView(value);
 if(method==='chat.list')return list(value).map(m=>{const p=object(m,['id','role','text','createdAt']);uuid(p.id);if(!['user','assistant'].includes(String(p.role))||typeof p.text!=='string')return bad();integer(p.createdAt);return p;});
 if(method==='edit.list'){const p=object(value,['candidates','publication']);for(const c of list(p.candidates)){const r=object(c,['id','siteId','jobId','baseRevision','baseDraftId','baseManifestId','parentRevisionId','manifestId','status','validation','summary','createdAt','acceptance','instruction','job']);for(const k of ['id','siteId','jobId','baseDraftId','baseManifestId','parentRevisionId'])uuid(r[k]);integer(r.baseRevision);integer(r.createdAt);if(r.manifestId!==null)uuid(r.manifestId);if(!['queued','running','checking','ready','rejected','accepted','conflict','failed'].includes(String(r.status))||typeof r.summary!=='string'||typeof r.instruction!=='string')return bad();validate('edit.request',r.job);if(r.validation!==null){const v=object(r.validation,['ok','issues','screenshotIds']);if(typeof v.ok!=='boolean')return bad();list(v.screenshotIds).forEach(uuid);list(v.issues).forEach(i=>{const issue=object(i,['code','message','path']);string(issue.code,100);string(issue.message,4000);if(issue.path!==undefined)string(issue.path,240);});}if(r.acceptance!==null){const a=object(r.acceptance,['expectedRevision','state']);integer(a.expectedRevision);if(!['pending','completed','conflict'].includes(String(a.state)))return bad();}}if(p.publication!==null){const q=object(p.publication,['id','siteId','revisionId','manifestId','expectedRevision','state']);for(const key of ['id','siteId','revisionId','manifestId'])uuid(q[key]);integer(q.expectedRevision);if(!['pending','completed','conflict'].includes(String(q.state)))return bad();}return p;}
 if(method==='edit.request'){const p=object(value,['id','siteId','kind','stage','state','checkpointId','baseRevision']);uuid(p.id);uuid(p.siteId);if(!['generate','edit'].includes(String(p.kind))||!['queued','running','paused','waiting_provider','needs_attention','completed','cancelled'].includes(String(p.state)))return bad();string(p.stage,100);integer(p.baseRevision);if(p.checkpointId!==null)uuid(p.checkpointId);return p;}
 if(method==='preview.open'){const p=object(value,['url']);return {url:string(p.url,4000)};}
 if(method==='admin.users')return list(value).map(u=>{const p=object(u,['id','email','role','active']);uuid(p.id);string(p.email,254);if(!['user','spec-user','admin'].includes(String(p.role))||typeof p.active!=='boolean')return bad();return p;});
 if(method==='admin.integrations'){const p=object(value,['database','auth','storage','queue','publication','invitations']);if(Object.values(p).some(v=>!['configured','unavailable'].includes(String(v))))return bad();return p;}
 if(method==='catalog.list'){const p=object(value,['styles','references']);for(const s of list(p.styles)){const v=object(s,['id','name','version','enabled','referenceIds']);string(v.id,100);string(v.name,200);string(v.version,100);if(typeof v.enabled!=='boolean')return bad();list(v.referenceIds).forEach(x=>string(x,100));}for(const r of list(p.references)){const v=object(r,['id','name','url','viewedAt','palette','typography','density','adaptations','description']);for(const k of ['id','name','url','viewedAt','typography','density','description'])string(v[k],4000);const url=new URL(String(v.url));if(!['https:','http:'].includes(url.protocol))return bad();list(v.palette).forEach(x=>string(x,200));list(v.adaptations).forEach(x=>string(x,4000));}return p;}
 if(method==='admin.invite'){const p=object(value,['id','state']);uuid(p.id);if(p.state!=='completed')return bad();return p;}
 const p=object(value,['ok']);if(p.ok!==true)return bad();return p;
}
export class RemoteClient {
 readonly mode='managed';
 constructor(readonly base:string,private token:()=>Promise<string|null>,private transport:typeof fetch=fetch,private onDispose?:()=>void){const u=new URL(base);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new AppError('INVALID_INPUT','Требуется HTTPS-адрес API без пути.');this.base=u.origin;}
 dispose(){this.onDispose?.();}
 async modelSettings<T>(_request:unknown):Promise<T>{throw new AppError('UNAVAILABLE','Настройки локальной модели доступны в локальном режиме.');}
 async request<T>(method:string,params:unknown={}):Promise<T>{
  const p=object(params,['siteId','revisionId','instruction','expectedRevision','candidateId','domain','about','referenceId','logoAssetId','id','enabled','description','email','role','active','userIds','cursor']);
  if(method==='device.status')return {mode:'blocked',available:false,activeJobs:0,maxJobs:2,model:null,images:'disabled',storage:'managed',publication:'unavailable'} as T;
  let path:string,verb='GET',body:unknown;
  switch(method){
   case 'session':path='/session';break;
   case 'site.list':path='/sites'+(p.cursor===undefined?'':'?cursor='+uuid(p.cursor));break;
   case 'site.create':path='/sites';verb='POST';body=p;break;
   case 'edit.list':path=`/sites/${uuid(p.siteId)}/candidates`;break;
   case 'chat.list':path=`/sites/${uuid(p.siteId)}/chat`;break;
   case 'edit.request':path=`/sites/${uuid(p.siteId)}/edits`;verb='POST';body={instruction:p.instruction,expectedRevision:p.expectedRevision,...(p.candidateId?{candidateId:p.candidateId}:{})};break;
   case 'edit.accept':case 'edit.reject':path=`/sites/${uuid(p.siteId)}/candidates/${uuid(p.candidateId)}/${method==='edit.accept'?'accept':'reject'}`;verb='POST';body=method==='edit.accept'?{expectedRevision:p.expectedRevision}:{};break;
   case 'preview.open':path=`/sites/${uuid(p.siteId)}/revisions/${uuid(p.revisionId)}/preview`;break;
   case 'catalog.list':path='/catalog';break;
   case 'catalog.style.update':path=`/catalog/styles/${encodeURIComponent(string(p.id,100))}`;verb='PATCH';body={enabled:p.enabled};break;
   case 'catalog.reference.update':path=`/catalog/references/${encodeURIComponent(string(p.id,100))}`;verb='PATCH';body={description:p.description};break;
   case 'admin.users':path='/admin/users';break;
   case 'admin.integrations':path='/admin/integrations';break;
   case 'admin.invite':path='/admin/invitations';verb='POST';body={email:p.email,role:p.role};break;
   case 'admin.user.update':path=`/admin/users/${uuid(p.id)}`;verb='PATCH';body={role:p.role,active:p.active};break;
   case 'admin.assignments':path=`/admin/sites/${uuid(p.siteId)}/assignments`;verb='PUT';body={userIds:p.userIds};break;
   default:throw new AppError('UNAVAILABLE','Эта функция управляемого режима ещё не подключена.');
  }
  const token=await this.token();if(!token)throw new AppError('UNAUTHENTICATED','Войдите в систему.');
  let response:Response;try{const transport=this.transport;response=await transport(this.base+path,{method:verb,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',cache:'no-store'});}catch{throw new AppError('UNAVAILABLE','Нет связи с общим API.');}
  let data:unknown;try{data=await response.json();}catch{return bad();}
  if(!response.ok){const p=object(data,['error','requestId']),e=object(p.error,['code','message']);string(p.requestId,100);const codes=['UNAUTHENTICATED','UNAVAILABLE','FORBIDDEN','NOT_FOUND','CONFLICT','INVALID_INPUT','DUPLICATE_DOMAIN','STALE_LEASE','PROVIDER_WAIT','NEEDS_ATTENTION'];if(!codes.includes(String(e.code)))return bad();throw new AppError(e.code as AppError['code'],string(e.message,500));}
  const value=validate(method,data);
  if(method==='preview.open'){const url=new URL((value as {url:string}).url);if(url.origin!==this.base||url.pathname!==`/preview/${p.siteId}/${p.revisionId}/index.html`||url.username||url.password||url.hash||[...url.searchParams.keys()].join(',')!=='cap'||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(url.searchParams.get('cap')??''))return bad();if(isTauri())await invoke('open_remote_preview',{url:url.href});else window.open(url.href,'_blank','noopener,noreferrer');}
  return value as T;
 }
}
