import type { EditRequest } from './editing.js';
export type Role = 'user' | 'spec-user' | 'admin';
export interface Principal { userId: string; role: Role }
export interface SiteInput { domain: string; about?: string; referenceId?: string; logoAssetId?: string }
export interface Site {
  id: string; domain: string; ownerId: string; assignedUserIds: string[]; input: SiteInput;
  revision: number; draftId: string | null; publishedId: string | null;
  generationStatus: string; domainStatus: string;
}
export interface Revision {
  id: string; siteId: string; parentId: string | null; manifestId: string;
  kind: 'draft' | 'candidate' | 'published'; createdAt: number;
}
/** Trusted immutable revision records; site draft/published pointers refer to Revision.id, never a manifest ID. */
export interface RevisionRepository {
  put(revision: Revision): Promise<void>;
  get(id: string): Promise<Revision | null>;
}
export interface ArtifactFile { path: string; bytes: Uint8Array; mediaType: string }
export interface Manifest {
  id: string; siteId: string; templateVersion: string; createdAt: number;
  files: { path: string; objectKey: string; size: number; sha256: string; sha1: string; mediaType: string }[];
}
export interface Job {
  id: string; siteId: string; kind: 'generate' | 'edit'; stage: string;
  state: 'queued' | 'running' | 'paused' | 'waiting_provider' | 'needs_attention' | 'completed' | 'cancelled';
  checkpointId: string | null; baseRevision: number;
  generation?: { seed: number; styleId: string; templateVersion: string };
  edit?: EditRequest;
}
export interface Lease { jobId: string; workerId: string; generation: number; expiresAt: number }
export interface ValidationReport {
  ok: boolean; issues: { code: string; path?: string; message: string }[]; screenshotIds: string[];
}
export type AppErrorCode = 'INVALID_INPUT' | 'DUPLICATE_DOMAIN' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' |
  'STALE_LEASE' | 'PROVIDER_WAIT' | 'NEEDS_ATTENTION';
export class AppError extends Error {
  constructor(public readonly code: AppErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'AppError';
  }
}
export interface Clock { now(): number }
export interface IdSource { next(): string }
export type Action = 'site:create' | 'site:read' | 'site:edit' | 'site:publish' | 'site:export' | 'admin:manage';
// Registry identity and canonical domain are immutable; all edits advance revision.
export type SitePatch = Partial<Pick<Site, 'assignedUserIds' | 'input' | 'draftId' | 'publishedId' | 'generationStatus' | 'domainStatus'>>;
export interface SiteRepository {
  create(input: SiteInput, principal: Principal): Promise<Site>;
  get(id: string): Promise<Site | null>;
  list(principal: Principal, cursor?: string, limit?: number): Promise<{ items: Site[]; nextCursor: string | null }>;
  compareAndSet(siteId: string, expectedRevision: number, patch: SitePatch): Promise<Site>;
}
export interface ArtifactStore {
  put(siteId: string, files: ArtifactFile[], templateVersion: string): Promise<Manifest>;
  read(manifestId: string): Promise<ArtifactFile[]>;
}
export interface FileTools {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  replace(path: string, oldText: string, newText: string): Promise<void>;
}
export interface Checkpoint {
  id: string; jobId: string; stage: string; manifestId: string | null; stateKey: string; createdAt: number;
}
export interface CheckpointStore {
  save(job: Job, lease: Lease, state: Record<string, unknown>, files: ArtifactFile[]): Promise<Checkpoint>;
  load(id: string): Promise<{ checkpoint: Checkpoint; state: Record<string, unknown>; files: ArtifactFile[] }>;
}
export interface Queue {
  enqueue(job: Job): Promise<void>;
  claim(workerId: string): Promise<{ job: Job; lease: Lease } | null>;
  heartbeat(lease: Lease): Promise<Lease>;
  checkpoint(lease: Lease, checkpoint: Checkpoint): Promise<void>;
  finish(lease: Lease, state: Job['state']): Promise<void>;
}
export type PublicationState = 'pending' | 'uploading' | 'creating' | 'checking' | 'promoting' | 'reconciling' |
  'waiting_quota' | 'awaiting_dns' | 'published' | 'needs_attention';
export interface PublicationPort { advance(intentId: string): Promise<PublicationState> }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: number }
export interface ModelRequest {
  mode: 'generate' | 'edit'; site: Site; instruction: string; baseManifestId: string | null;
  conversation: ChatMessage[]; styleId: string; selectedElementId?: string;
  operationId?: string; instructions?: string; continuation?: ModelContinuation;
}
/** Private, serializable provider replay. Never place this in public chat DTOs. */
export interface ModelContinuation {
  provider: 'openai-responses'; version: 1; binding: string;
  items: Record<string, unknown>[]; turns: number; retries: number; retryAt: number; transportExhausted: boolean; requestPending:boolean;
  inputTokens: number; outputTokens: number; responseId: string | null;
  terminal: 'final' | 'refused' | 'incomplete' | 'failed' | 'cancelled' | 'stalled' | null;
  summary: string; seen: Record<string, number>;
}
export interface ModelRunHooks { checkpoint(continuation: ModelContinuation): Promise<void> }
export interface ModelResult { summary: string; inputTokens: number; outputTokens: number; providerResponseId?: string; continuation?: ModelContinuation }
export interface ModelPort {
  readonly retryOwner?: 'adapter';
  readonly identity?: string;
  run(request: ModelRequest, tools: FileTools, signal: AbortSignal, hooks?: ModelRunHooks): Promise<ModelResult>;
}
