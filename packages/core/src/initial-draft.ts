import {AppError,type Job,type Revision,type Site} from '../../contracts/src/model.js';
import {uuid,integer} from '../../contracts/src/http.js';
import {record} from '../../contracts/src/inputs.js';
import type {CheckpointEvidence} from '../../contracts/src/recovery.js';
/** Only the first pointer initialization under a current generation lease. Ordinary edits use CAS. */
export function initialDraft(job:Job,site:Site,evidence:CheckpointEvidence):Revision|null {
 if(job.kind!=='generate'||evidence.checkpoint.stage!=='publication')return null;
 const s=evidence.state;
 if(s.jobId!==job.id||s.siteId!==site.id||s.baseRevision!==job.baseRevision||site.revision!==job.baseRevision||evidence.checkpoint.manifestId!==s.manifestId||!record(s.validation)||s.validation.ok!==true||!Array.isArray(s.validation.issues)||s.validation.issues.length||s.parentRevisionId!==null)
  throw new AppError('CONFLICT','Первый черновик не соответствует проверенному заданию.');
 const revision:Revision={id:uuid(s.revisionId),siteId:site.id,parentId:null,manifestId:uuid(s.manifestId),createdAt:integer(s.revisionCreatedAt),kind:'draft'};
 if(site.publishedId||site.draftId&&site.draftId!==revision.id)throw new AppError('CONFLICT','Первый черновик уже установлен иначе.');
 return revision;
}
export function sameRevision(a:Revision,b:Revision){return (['id','siteId','parentId','manifestId','kind','createdAt'] as const).every(k=>a[k]===b[k]);}
