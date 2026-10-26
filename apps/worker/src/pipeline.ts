import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../../packages/contracts/src/model.js';
import type { ArtifactFile, ArtifactStore, ChatMessage, CheckpointStore, Clock, FileTools, Job, Lease, ModelPort, ModelResult, PublicationPort, Queue, RevisionRepository, SiteRepository, ValidationReport } from '../../../packages/contracts/src/model.js';
import { record } from '../../../packages/contracts/src/inputs.js';
import { artifactMediaType, checkArtifacts } from '../../../packages/core/src/artifacts.js';
import { createFileTools } from './files/tools.js';
import { validateSite } from './validation/browser.js';
export interface WorkerDeps {
  queue: Queue; sites: SiteRepository; artifacts: ArtifactStore; checkpoints: CheckpointStore;
  revisions: RevisionRepository;
  model: ModelPort; clock: Clock; publication: PublicationPort; workspace: string;
  templates: { load(styleId: string, version: string): Promise<ArtifactFile[]>; prepare?(job: Job, batchIndex: number, seed: number, referenceId?: string): Promise<Job> };
  prepare?: (job: Job) => Promise<Job>;
  request?: { instruction: string; conversation: ChatMessage[]; selectedElementId?: string };
  validate?: (files: ArtifactFile[]) => Promise<ValidationReport>;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
interface PipelineState extends Record<string, unknown> {
  schema: 1; jobId: string; siteId: string; baseRevision: number; selection: NonNullable<Job['generation']>;
  brief: string; image: string | null; repairAttempts: number; transportRetries: number; transcript: ModelResult[];
  toolTranscript: { operation: string; path?: string }[];
  manifestId: string | null; intentId: string | null; instruction: string; conversation: ChatMessage[];
  baseManifestId: string | null; parentRevisionId: string | null; revisionId: string | null; revisionCreatedAt: number | null;
  selectedElementId?: string; error?: string;
}
const stages = ['assets', 'generate', 'validate', 'archive', 'publication', 'completed'];
function validReport(value: unknown): value is ValidationReport {
  return record(value) && typeof value.ok === 'boolean' && Array.isArray(value.issues) && value.ok === (value.issues.length === 0) &&
    value.issues.every((issue) => record(issue) && typeof issue.code === 'string' && typeof issue.message === 'string' && (issue.path === undefined || typeof issue.path === 'string')) &&
    Array.isArray(value.screenshotIds) && value.screenshotIds.every((id) => typeof id === 'string');
}
function parseState(value: Record<string, unknown>, job: Job): PipelineState {
  const selection = value.selection;
  if (value.schema !== 1 || value.jobId !== job.id || value.siteId !== job.siteId || value.baseRevision !== job.baseRevision ||
      !record(selection) || !Number.isSafeInteger(selection.seed) || (selection.seed as number) < 0 || typeof selection.styleId !== 'string' || !selection.styleId ||
      typeof selection.templateVersion !== 'string' || !selection.templateVersion || typeof value.brief !== 'string' || !value.brief ||
      (value.image !== null && value.image !== 'assets/network.svg') || !Number.isInteger(value.repairAttempts) ||
      (value.repairAttempts as number) < 0 || (value.repairAttempts as number) > 2 || !Number.isInteger(value.transportRetries) ||
      (value.transportRetries as number) < 0 || (value.transportRetries as number) > 3 || !Array.isArray(value.transcript) ||
      !value.transcript.every((r) => record(r) && typeof r.summary === 'string' && Number.isSafeInteger(r.inputTokens) && Number.isSafeInteger(r.outputTokens)) ||
      !Array.isArray(value.toolTranscript) || value.toolTranscript.length > 5000 || !value.toolTranscript.every((entry) => record(entry) &&
        ['list', 'read', 'write', 'replace'].includes(String(entry.operation)) && (entry.path === undefined || typeof entry.path === 'string')) ||
      (value.manifestId !== null && typeof value.manifestId !== 'string') || (value.intentId !== null && typeof value.intentId !== 'string') ||
      (value.baseManifestId !== null && typeof value.baseManifestId !== 'string') || (value.parentRevisionId !== null && typeof value.parentRevisionId !== 'string') ||
      (value.revisionId !== null && typeof value.revisionId !== 'string') || (value.revisionCreatedAt !== null && !Number.isSafeInteger(value.revisionCreatedAt)) ||
      typeof value.instruction !== 'string' || !Array.isArray(value.conversation) || !value.conversation.every((m) => record(m) &&
        typeof m.id === 'string' && ['user', 'assistant'].includes(String(m.role)) && typeof m.text === 'string' && Number.isSafeInteger(m.createdAt)) ||
      (value.selectedElementId !== undefined && typeof value.selectedElementId !== 'string')) {
    throw new AppError('INVALID_INPUT', 'Private checkpoint does not match this job or is corrupt.');
  }
  return value as PipelineState;
}
function seedFor(id: string) { let seed = 2166136261; for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619); return seed >>> 0; }
const topics = ['Observable event pipelines', 'Privacy-aware analytics', 'Reliable distributed storage', 'Open protocol infrastructure', 'Verifiable digital records'];
const illustration = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180" role="img" aria-label="Connected data processing stages"><path d="M80 90H520" stroke="#3457bb" stroke-width="4"/><g fill="#e7efff" stroke="#24449b" stroke-width="3"><circle cx="80" cy="90" r="38"/><circle cx="300" cy="90" r="38"/><circle cx="520" cy="90" r="38"/></g></svg>';

/** Stages commit private snapshots before queue advancement. A retry starts only from that snapshot.
 * The caller owns scheduling/concurrency; this run renews its lease while model/browser work is pending.
 */
export async function runJob(job: Job, initialLease: Lease, deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  let lease = initialLease; let state: PipelineState | undefined; let files: ArtifactFile[] = []; let stage = job.stage;
  const localAbort = new AbortController(); const activeSignal = AbortSignal.any([signal, localAbort.signal]);
  let leaseError: unknown; let heartbeat: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => { lease = await deps.queue.heartbeat(lease); }).catch((error: unknown) => { leaseError = error; localAbort.abort(error); });
  }, 30_000);
  async function check() { activeSignal.throwIfAborted(); if (leaseError) throw leaseError; lease = await deps.queue.heartbeat(lease); }
  async function save(next: string) {
    await check();
    const checkpoint = await deps.checkpoints.save({ ...job, stage: next }, lease, state!, files);
    await deps.queue.checkpoint(lease, checkpoint); job.checkpointId = checkpoint.id; job.stage = next; stage = next;
  }
  try {
    await check();
    const site = await deps.sites.get(job.siteId); if (!site) throw new AppError('NOT_FOUND', 'Site no longer exists.');
    if (job.checkpointId) {
      const saved = await deps.checkpoints.load(job.checkpointId);
      if (saved.checkpoint.jobId !== job.id || saved.checkpoint.id !== job.checkpointId || !stages.includes(saved.checkpoint.stage)) throw new AppError('INVALID_INPUT', 'Checkpoint identity or stage is invalid.');
      state = parseState(saved.state, job); files = saved.files; checkArtifacts(files); stage = saved.checkpoint.stage;
      if (['archive', 'publication', 'completed'].includes(stage) && (!validReport(state.validation) || !state.validation.ok)) throw new AppError('INVALID_INPUT', 'Validated stages require successful validation evidence.');
      if (['publication', 'completed'].includes(stage) && (!state.manifestId || state.intentId !== `${job.id}:${state.manifestId}` || state.manifestId !== saved.checkpoint.manifestId ||
          (job.kind === 'generate' && (!state.revisionId || state.revisionCreatedAt === null)))) throw new AppError('INVALID_INPUT', 'Publication checkpoint is incomplete or has a different intent.');
    }
    // A crash between site CAS and the final checkpoint is reconciled without another publication.
    if (job.kind === 'generate' && state?.revisionId && site.publishedId === state.revisionId && site.revision === job.baseRevision + 1) {
      const revision = await deps.revisions.get(state.revisionId);
      if (!revision || revision.siteId !== site.id || revision.manifestId !== state.manifestId || revision.kind !== 'published') throw new AppError('INVALID_INPUT', 'Published revision does not match the checkpoint.');
      await save('completed'); await deps.queue.finish(lease, 'completed'); return;
    }
    if (site.revision !== job.baseRevision) throw new AppError('CONFLICT', 'Site changed after this job was queued.');
    if (!state) {
      if (job.kind === 'edit' && !site.draftId && !site.publishedId) throw new AppError('INVALID_INPUT', 'Editing needs an existing site artifact.');
      const parentRevisionId = site.draftId ?? site.publishedId;
      const parent = parentRevisionId ? await deps.revisions.get(parentRevisionId) : null;
      if (parentRevisionId && (!parent || parent.siteId !== site.id)) throw new AppError('INVALID_INPUT', 'Base revision is missing or belongs to another site.');
      const seed = seedFor(job.id);
      const prepared = job.generation ? job : deps.prepare ? await deps.prepare(job) : await deps.templates.prepare?.(job, 0, seed, site.input.referenceId);
      if (!prepared?.generation && site.input.referenceId) throw new AppError('INVALID_INPUT', 'A catalog is required to resolve the selected reference.');
      const selection = prepared?.generation ?? { seed, styleId: ['light-product', 'dark-tech', 'editorial', 'corporate', 'diagram'][seed % 5]!, templateVersion: '1.0.0' };
      const brief = site.input.about?.trim() || `${topics[selection.seed % topics.length]} for ${site.domain}`;
      state = { schema: 1, jobId: job.id, siteId: site.id, baseRevision: job.baseRevision, selection, brief,
        image: selection.seed % 100 < 10 ? 'assets/network.svg' : null, repairAttempts: 0, transportRetries: 0, transcript: [], toolTranscript: [], manifestId: null, intentId: null,
        baseManifestId: parent?.manifestId ?? null, parentRevisionId, revisionId: null, revisionCreatedAt: null,
        instruction: deps.request?.instruction ?? brief, conversation: deps.request?.conversation ?? [],
        ...(deps.request?.selectedElementId === undefined ? {} : { selectedElementId: deps.request.selectedElementId }) };
      parseState(state, job); await save('assets');
    }
    if (stage === 'assets') {
      files = job.kind === 'edit' ? await deps.artifacts.read(state.baseManifestId!) : await deps.templates.load(state.selection.styleId, state.selection.templateVersion);
      if (state.image && job.kind === 'generate') {
        files.push({ path: state.image, bytes: new TextEncoder().encode(illustration), mediaType: 'image/svg+xml' });
        const html = files.find((f) => f.path === 'index.html');
        if (html) html.bytes = new TextEncoder().encode(new TextDecoder().decode(html.bytes).replace('</main>', '<figure><img src="assets/network.svg" alt="Connected data processing stages" width="600" height="180"></figure></main>'));
      }
      checkArtifacts(files); await save('generate');
    }
    async function freshTools() {
      // Each attempt has a fresh private workspace; partial failed provider writes never leak into a retry.
      const tools = await createFileTools(join(deps.workspace, randomUUID()));
      for (const file of files) {
        if (!['text/html', 'text/css', 'text/javascript', 'image/svg+xml'].includes(file.mediaType)) continue;
        await tools.write(file.path, new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
      }
      return tools;
    }
    async function collect(tools: FileTools) {
      const textFiles: ArtifactFile[] = [];
      for (const path of await tools.list()) textFiles.push({ path, bytes: new TextEncoder().encode(await tools.read(path)), mediaType: artifactMediaType(path) });
      files = [...files.filter((file) => !['text/html', 'text/css', 'text/javascript', 'image/svg+xml'].includes(file.mediaType)), ...textFiles]; checkArtifacts(files);
    }
    async function generate(instruction: string) {
      while (true) {
        await check(); const tools = await freshTools();
        async function traced<T>(operation: string, path: string | undefined, action: () => Promise<T>): Promise<T> {
          activeSignal.throwIfAborted();
          if (state!.toolTranscript.length >= 5000) throw new AppError('NEEDS_ATTENTION', 'Model tool-call limit reached.');
          state!.toolTranscript.push(path === undefined ? { operation } : { operation, path }); return action();
        }
        const modelTools: FileTools = {
          list: () => traced('list', undefined, () => tools.list()),
          read: (path) => traced('read', path, () => tools.read(path)),
          write: (path, text) => traced('write', path, () => tools.write(path, text)),
          replace: (path, oldText, newText) => traced('replace', path, () => tools.replace(path, oldText, newText)),
        };
        let result: ModelResult;
        try { result = await deps.model.run({ mode: job.kind, site: { ...site!, input: { ...site!.input, about: state!.brief } }, instruction,
        baseManifestId: state!.baseManifestId, conversation: state!.conversation, styleId: state!.selection.styleId,
          ...(state!.selectedElementId === undefined ? {} : { selectedElementId: state!.selectedElementId }) }, modelTools, activeSignal);
        } catch (error) {
          activeSignal.throwIfAborted();
          const transient = error instanceof Error && 'code' in error && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(error.code));
          if (!transient) throw error;
          if (state!.transportRetries >= 3) throw new AppError('PROVIDER_WAIT', 'Model transport failed after three retries.', { cause: error });
          state!.transportRetries++; await save(stage);
          await (deps.delay ?? ((milliseconds, abort) => sleep(milliseconds, undefined, { signal: abort })))(1000 * 2 ** (state!.transportRetries - 1), activeSignal);
          continue;
        }
        if (!result || typeof result.summary !== 'string' || !Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0 || !Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0) throw new AppError('INVALID_INPUT', 'Invalid model result.');
        state!.transportRetries = 0; state!.transcript.push(result); await collect(tools); return;
      }
    }
    if (stage === 'generate') { await generate(state.instruction); await save('validate'); }
    if (stage === 'validate') {
      while (true) {
        await check(); const report = await (deps.validate ?? validateSite)(files); activeSignal.throwIfAborted();
        if (!validReport(report)) throw new AppError('INVALID_INPUT', 'Invalid validation report.');
        state.validation = report;
        if (report.ok) { await save('archive'); break; }
        if (state.repairAttempts >= 2) throw new AppError('NEEDS_ATTENTION', 'Validation failed after two repairs.');
        state.repairAttempts++; await save('validate');
        await generate(`${state.instruction}\nValidation issues:\n${JSON.stringify(report.issues)}`); await save('validate');
      }
    }
    if (stage === 'archive') {
      await check(); const manifest = await deps.artifacts.put(site.id, files, state.selection.templateVersion);
      state.manifestId = manifest.id; state.intentId = `${job.id}:${manifest.id}`;
      state.revisionId = job.kind === 'generate' ? randomUUID() : null; state.revisionCreatedAt = deps.clock.now(); await save('publication');
    }
    if (stage === 'publication') {
      const current = await deps.sites.get(site.id);
      if (!current || current.revision !== job.baseRevision) throw new AppError('CONFLICT', 'Site changed before publication.');
      // Edits produce a validated candidate only. The editor's explicit accept/reject flow owns draft CAS.
      if (job.kind === 'generate') {
        await check(); const publication = await deps.publication.advance(state.intentId!);
        if (publication === 'needs_attention') throw new AppError('NEEDS_ATTENTION', 'Publication needs attention.');
        if (publication !== 'published') { await deps.queue.finish(lease, 'waiting_provider'); return; }
        await check();
        await deps.revisions.put({ id: state.revisionId!, siteId: site.id, parentId: state.parentRevisionId, manifestId: state.manifestId!, kind: 'published', createdAt: state.revisionCreatedAt! });
        await deps.sites.compareAndSet(site.id, job.baseRevision, { publishedId: state.revisionId, draftId: null, generationStatus: 'completed' });
      }
      await save('completed');
    }
    await deps.queue.finish(lease, 'completed');
  } catch (error) {
    if (leaseError || (error instanceof AppError && error.code === 'STALE_LEASE')) throw error;
    if (state && !activeSignal.aborted) { state.error = error instanceof Error ? error.message : String(error); await save(stage); }
    await deps.queue.finish(lease, activeSignal.aborted ? 'paused' : error instanceof AppError && error.code === 'PROVIDER_WAIT' ? 'waiting_provider' : 'needs_attention');
  } finally { clearInterval(timer); await heartbeat; }
}
