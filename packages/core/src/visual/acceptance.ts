import type {Candidate} from '../../../contracts/src/editing.js';
import type {Site,Revision} from '../../../contracts/src/model.js';
/** Trusted internal outcome of committing the existing acceptance intent; never a transport DTO. */
export type VisualAcceptanceReceipt={state:'completed';site:Site;journalCommitted:true}|{state:'failed';code:'FORBIDDEN'|'CONFLICT';message:string;journalCommitted:true};
export function completeVisualAcceptance(candidate:Candidate):Candidate {
 const next=structuredClone(candidate);next.status='accepted';next.acceptance!.state='completed';next.visualSave!.state='completed';delete next.visualSave!.error;return next;
}
export function failVisualAcceptance(candidate:Candidate,message:string):Candidate {
 const next=structuredClone(candidate);next.visualSave!.state='failed';next.visualSave!.error=message;if(next.acceptance?.state==='pending'){next.acceptance.state='conflict';next.status='conflict';}return next;
}
export function installedVisualAcceptance(site:Site,candidate:Candidate,revision:Revision|null):boolean {
 return !!candidate.acceptance&&site.draftId===candidate.id&&site.revision===candidate.acceptance.expectedRevision+1&&candidate.baseRevision===candidate.acceptance.expectedRevision&&revision?.id===candidate.id&&revision.siteId===site.id&&revision.manifestId===candidate.manifestId&&revision.parentId===candidate.parentRevisionId;
}
