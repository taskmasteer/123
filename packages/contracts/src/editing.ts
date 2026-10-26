import type { ChatMessage, Job, ValidationReport } from './model.js';
import { AppError } from './model.js';
import { record, nonemptyString } from './inputs.js';

export type CandidateStatus = 'queued' | 'running' | 'checking' | 'ready' | 'rejected' | 'accepted' | 'conflict' | 'failed';
export interface EditRequest {
  candidateId: string;
  baseDraftId: string;
  baseManifestId: string;
  parentRevisionId: string;
  instruction: string;
  conversation: ChatMessage[];
}
export interface Candidate {
  id: string;
  siteId: string;
  jobId: string;
  baseRevision: number;
  baseDraftId: string;
  baseManifestId: string;
  parentRevisionId: string;
  manifestId: string | null;
  status: CandidateStatus;
  validation: ValidationReport | null;
  summary: string;
  createdAt: number;
  job: Job;
  acceptance: { expectedRevision: number; state: 'pending' | 'completed' | 'conflict' } | null;
}
export interface PublishIntent {
  id: string;
  siteId: string;
  revisionId: string;
  manifestId: string;
  expectedRevision: number;
  state: 'pending' | 'completed' | 'conflict';
}
export interface EditingState {
  version: 1;
  candidates: Candidate[];
  messages: (ChatMessage & { siteId: string; candidateId: string })[];
  publications: PublishIntent[];
}
export interface EditingStore {
  transaction<T>(operation: (state: EditingState) => Promise<{ value?: EditingState; result: T }> | { value?: EditingState; result: T }): Promise<T>;
}
export function validEditRequest(value: unknown): value is EditRequest {
  return record(value) && ['candidateId', 'baseDraftId', 'baseManifestId', 'parentRevisionId'].every(key => nonemptyString(value[key])) &&
    typeof value.instruction === 'string' && !!value.instruction.trim() && value.instruction.length <= 8000 &&
    Array.isArray(value.conversation) && value.conversation.every(m => record(m) && nonemptyString(m.id) &&
      ['user', 'assistant'].includes(String(m.role)) && typeof m.text === 'string' && Number.isSafeInteger(m.createdAt));
}
export function parseEditingState(value: unknown): EditingState {
  const invalid = () => { throw new AppError('INVALID_INPUT', 'Invalid persisted editing state.'); };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.candidates) || !Array.isArray(value.messages) || !Array.isArray(value.publications)) return invalid();
  if (!value.candidates.every(c => record(c) && ['id', 'siteId', 'jobId', 'baseDraftId', 'baseManifestId', 'parentRevisionId'].every(k => nonemptyString(c[k])) &&
    Number.isSafeInteger(c.baseRevision) && (c.baseRevision as number) >= 0 && Number.isSafeInteger(c.createdAt) && typeof c.summary === 'string' &&
    ['queued', 'running', 'checking', 'ready', 'rejected', 'accepted', 'conflict', 'failed'].includes(String(c.status)) &&
    (c.manifestId === null || nonemptyString(c.manifestId)) && record(c.job) && c.job.id === c.jobId && c.job.siteId === c.siteId && c.job.kind === 'edit' &&
    validEditRequest(c.job.edit) && c.job.edit.candidateId === c.id && c.job.baseRevision === c.baseRevision &&
    (c.validation === null || (record(c.validation) && typeof c.validation.ok === 'boolean' && Array.isArray(c.validation.issues) && Array.isArray(c.validation.screenshotIds) && c.validation.screenshotIds.every(nonemptyString))) &&
    (c.acceptance === null || (record(c.acceptance) && Number.isSafeInteger(c.acceptance.expectedRevision) && ['pending', 'completed', 'conflict'].includes(String(c.acceptance.state)))))) return invalid();
  if (!value.messages.every(m => record(m) && ['id', 'siteId', 'candidateId'].every(k => nonemptyString(m[k])) &&
    ['user', 'assistant'].includes(String(m.role)) && typeof m.text === 'string' && Number.isSafeInteger(m.createdAt))) return invalid();
  if (!value.publications.every(p => record(p) && ['id', 'siteId', 'revisionId', 'manifestId'].every(k => nonemptyString(p[k])) &&
    Number.isSafeInteger(p.expectedRevision) && ['pending', 'completed', 'conflict'].includes(String(p.state)))) return invalid();
  if (new Set(value.candidates.map(c => c.id)).size !== value.candidates.length || new Set(value.messages.map(m => m.id)).size !== value.messages.length) return invalid();
  return value as unknown as EditingState;
}
