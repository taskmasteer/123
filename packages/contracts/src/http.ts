import {AppError} from './model.js';
import type {Job,Site,Principal,Lease} from './model.js';
import type {Candidate} from './editing.js';
import {record,parseSiteInput} from './inputs.js';
export type JobView=Pick<Job,'id'|'siteId'|'kind'|'stage'|'state'|'checkpointId'|'baseRevision'>;
export type SiteView=Site&{job:JobView|null};
export type CandidateView=Omit<Candidate,'job'>&{instruction:string;job:JobView};
export interface SessionView {principal:Principal;mode:'managed';capabilities:{admin:boolean;edit:boolean;generation:boolean;publish:false;export:false;preview:boolean;nativeModelSettings:false}}
export function jobView(j:Job):JobView{return {id:j.id,siteId:j.siteId,kind:j.kind,stage:j.stage,state:j.state,checkpointId:j.checkpointId,baseRevision:j.baseRevision};}
export function candidateView(c:Candidate):CandidateView {return {id:c.id,siteId:c.siteId,jobId:c.jobId,baseRevision:c.baseRevision,baseDraftId:c.baseDraftId,baseManifestId:c.baseManifestId,parentRevisionId:c.parentRevisionId,manifestId:c.manifestId,status:c.status,validation:c.validation?{ok:c.validation.ok,issues:c.validation.issues.map(i=>({code:i.code,message:i.message,...(i.path?{path:i.path}:{})})),screenshotIds:[...c.validation.screenshotIds]}:null,summary:c.summary,createdAt:c.createdAt,acceptance:c.acceptance?{expectedRevision:c.acceptance.expectedRevision,state:c.acceptance.state}:null,instruction:c.job.edit?.instruction??'',job:jobView(c.job)};}
export function object(value:unknown,keys:string[]):Record<string,unknown>{if(!record(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new AppError('INVALID_INPUT','Некорректные поля запроса.');return value;}
export function uuid(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new AppError('INVALID_INPUT','Некорректный идентификатор.');return value;}
export function integer(value:unknown,min=0,max=Number.MAX_SAFE_INTEGER):number{if(!Number.isSafeInteger(value)||(value as number)<min||(value as number)>max)throw new AppError('INVALID_INPUT','Некорректное число.');return value as number;}
export function string(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new AppError('INVALID_INPUT','Некорректный текст.');return value;}
export function leaseDto(value:unknown):Lease {const p=object(value,['jobId','workerId','generation','expiresAt']);return {jobId:uuid(p.jobId),workerId:uuid(p.workerId),generation:integer(p.generation,1),expiresAt:integer(p.expiresAt)};}
/** Allowlist construction is deliberate: private fields cannot hitchhike in a network response. */
export function siteView(value:unknown):SiteView {
 const p=object(value,['id','domain','ownerId','assignedUserIds','input','revision','draftId','publishedId','generationStatus','domainStatus','job']);
 const input=parseSiteInput(p.input); if(!Array.isArray(p.assignedUserIds))throw new AppError('INVALID_INPUT','Некорректный сайт.');
 let job:JobView|null=null;
 if(p.job!==null&&p.job!==undefined){const j=object(p.job,['id','siteId','kind','stage','state','checkpointId','baseRevision']);
 if(!['generate','edit'].includes(String(j.kind))||!['queued','running','paused','waiting_provider','needs_attention','completed','cancelled'].includes(String(j.state)))throw new AppError('INVALID_INPUT','Некорректное задание.');
 job={id:uuid(j.id),siteId:uuid(j.siteId),kind:j.kind as Job['kind'],stage:string(j.stage,100),state:j.state as Job['state'],checkpointId:j.checkpointId===null?null:uuid(j.checkpointId),baseRevision:integer(j.baseRevision)};}
 return {id:uuid(p.id),domain:string(p.domain,253),ownerId:uuid(p.ownerId),assignedUserIds:p.assignedUserIds.map(uuid),input,revision:integer(p.revision),draftId:p.draftId===null?null:uuid(p.draftId),publishedId:p.publishedId===null?null:uuid(p.publishedId),generationStatus:string(p.generationStatus,100),domainStatus:string(p.domainStatus,100),job};
}
