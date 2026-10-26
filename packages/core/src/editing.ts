import { AppError } from '../../contracts/src/model.js';
import type { CheckpointStore, Clock, IdSource, Job, Principal, PublicationPort, Queue, RevisionRepository, Site, SiteRepository, ValidationReport } from '../../contracts/src/model.js';
import type { Candidate, EditingState, EditingStore, PublishIntent } from '../../contracts/src/editing.js';
import { record } from '../../contracts/src/inputs.js';
import { authorize } from './permissions.js';

export interface EditingDeps {
  sites: SiteRepository;
  store: EditingStore;
  revisions: RevisionRepository;
  checkpoints: CheckpointStore;
  queue: Queue & { get(id: string): Promise<Job | null>; current(siteId: string): Promise<Job | null>; cancel(id: string): Promise<void> };
  publication: PublicationPort;
  clock: Clock;
  ids: IdSource;
}
const terminal = new Set(['ready', 'accepted', 'rejected', 'conflict', 'failed']);
const busyMessage = 'Дождитесь завершения или отмените текущую правку.';

/** Checkpoint errors are private provider data: expose only a short, redacted first-line diagnostic. */
function safeDiagnostic(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 8192)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/gi, '[скрыто]')
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\b["']?\s*[:=][^\r\n;]*/gi, '[скрыто]')
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s;,]+)/gi, '[скрыто]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s;,]+/gi, '[скрыто]')
    .replace(/\b(?:sk-[\w-]+|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?|[A-Za-z0-9_+/=-]{40,})\b/g, '[скрыто]')
    .replace(/\b(?:https?|file):\/\/[^\s<>"']+/gi, '[скрыто]')
    .replace(/(?:\b[A-Z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private)\/)[^\r\n;<>"']*/gi, '[скрыто]')
    .split(/[\r\n]/, 1)[0]!
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  return text ? text.length > 400 ? text.slice(0, 399) + '…' : text : null;
}

/** Authorized domain transitions. The journal precedes external writes so a restart can reconcile CAS outcomes. */
export function createEditing(deps: EditingDeps) {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  }
  const read = () => deps.store.transaction(state => ({ result: structuredClone(state) }));
  const write = (change: (state: EditingState) => void) => deps.store.transaction(state => { change(state); return { value: state, result: undefined }; });
  async function siteFor(actor: Principal, siteId: string, action: 'site:read' | 'site:edit' | 'site:publish') {
    const site = await deps.sites.get(siteId);
    if (!site) throw new AppError('NOT_FOUND', 'Сайт не найден.');
    authorize(actor, action, site);
    return site;
  }
  function candidateFor(state: EditingState, siteId: string, candidateId: string) {
    const candidate = state.candidates.find(c => c.id === candidateId && c.siteId === siteId);
    if (!candidate) throw new AppError('NOT_FOUND', 'Вариант не найден.');
    return candidate;
  }
  async function updateCandidate(candidate: Candidate) {
    await write(state => { const index = state.candidates.findIndex(c => c.id === candidate.id); state.candidates[index] = candidate; });
  }
  async function evidence(candidate: Candidate) {
    const job = await deps.queue.get(candidate.jobId);
    if (!job?.checkpointId) throw new AppError('NOT_FOUND', 'Проверка варианта ещё не готова.');
    const saved = await deps.checkpoints.load(job.checkpointId), state = saved.state;
    if (saved.checkpoint.jobId !== candidate.jobId || state.jobId !== candidate.jobId || state.siteId !== candidate.siteId ||
      state.baseRevision !== candidate.baseRevision || state.revisionId !== candidate.id || !state.manifestId ||
      saved.checkpoint.manifestId !== state.manifestId || (candidate.manifestId !== null && candidate.manifestId !== state.manifestId) ||
      !['publication', 'completed'].includes(saved.checkpoint.stage) || !record(state.validation) || state.validation.ok !== true ||
      !Array.isArray(state.validation.issues) || state.validation.issues.length !== 0 || !Array.isArray(state.validation.screenshotIds) ||
      !state.validation.screenshotIds.every(id => typeof id === 'string')) throw new AppError('INVALID_INPUT', 'Проверка не соответствует варианту.');
    return { state, report: state.validation as unknown as ValidationReport, manifestId: state.manifestId as string };
  }
  async function failureDiagnostic(candidate: Candidate, job: Job): Promise<string | null> {
    if (!job.checkpointId || job.id !== candidate.jobId || job.siteId !== candidate.siteId || job.kind !== 'edit' ||
      job.baseRevision !== candidate.baseRevision || job.edit?.candidateId !== candidate.id) return null;
    try {
      const saved = await deps.checkpoints.load(job.checkpointId), state = saved.state;
      if (saved.checkpoint.id !== job.checkpointId || saved.checkpoint.jobId !== job.id || saved.checkpoint.stage !== job.stage ||
        state.jobId !== job.id || state.siteId !== candidate.siteId || state.baseRevision !== candidate.baseRevision ||
        state.baseManifestId !== candidate.baseManifestId || state.parentRevisionId !== candidate.parentRevisionId ||
        (state.revisionId !== null && state.revisionId !== candidate.id)) return null;
      return safeDiagnostic(state.error);
    } catch {
      // Missing/corrupt diagnostics must not prevent rejecting a failed operation or expose a storage error.
      return null;
    }
  }
  async function syncCandidate(candidate: Candidate) {
    if (candidate.status === 'rejected') {
      const job = await deps.queue.get(candidate.jobId);
      if (job && job.state !== 'cancelled') await deps.queue.cancel(job.id);
      return;
    }
    if (terminal.has(candidate.status)) return;
    let job = await deps.queue.get(candidate.jobId);
    if (!job) { await deps.queue.enqueue(candidate.job); job = await deps.queue.get(candidate.jobId); }
    if (!job) throw new AppError('NOT_FOUND', 'Задание не найдено.');
    if (job.state === 'completed') {
      const checked = await evidence(candidate);
      candidate.manifestId = checked.manifestId;
      candidate.validation = checked.report;
      const transcript = checked.state.transcript;
      candidate.summary = Array.isArray(transcript) && record(transcript.at(-1)) && typeof transcript.at(-1).summary === 'string' ? transcript.at(-1).summary : 'Правка проверена.';
      const site = await deps.sites.get(candidate.siteId);
      candidate.status = site?.revision === candidate.baseRevision ? 'ready' : 'conflict';
      await deps.revisions.put({ id: candidate.id, siteId: candidate.siteId, parentId: candidate.parentRevisionId, manifestId: candidate.manifestId, kind: 'candidate', createdAt: candidate.createdAt });
    } else if (job.state === 'needs_attention' || job.state === 'cancelled') {
      candidate.status = job.state === 'cancelled' ? 'rejected' : 'failed';
      const diagnostic = job.state === 'needs_attention' ? await failureDiagnostic(candidate, job) : null;
      candidate.summary = `Правка не завершена.${diagnostic ? ` Причина: ${diagnostic}` : ''} Черновик и публикация сохранены.`;
    } else {
      candidate.status = job.state !== 'running' ? 'queued' : ['validate', 'archive', 'publication'].includes(job.stage) ? 'checking' : 'running';
    }
    await write(state => {
      state.candidates[state.candidates.findIndex(c => c.id === candidate.id)] = candidate;
      if (terminal.has(candidate.status) && !state.messages.some(m => m.candidateId === candidate.id && m.role === 'assistant')) {
        state.messages.push({ id: deps.ids.next(), siteId: candidate.siteId, candidateId: candidate.id, role: 'assistant', text: candidate.summary, createdAt: deps.clock.now() });
      }
    });
  }
  async function settleAcceptance(candidate: Candidate): Promise<Site> {
    const intent = candidate.acceptance!;
    const site = await deps.sites.get(candidate.siteId);
    if (!site) throw new AppError('NOT_FOUND', 'Сайт не найден.');
    if (site.draftId === candidate.id && site.revision === intent.expectedRevision + 1) {
      candidate.status = 'accepted'; intent.state = 'completed'; await updateCandidate(candidate); return site;
    }
    if (site.revision !== intent.expectedRevision || (site.draftId ?? site.publishedId) !== candidate.baseDraftId) {
      candidate.status = 'conflict'; intent.state = 'conflict'; await updateCandidate(candidate);
      throw new AppError('CONFLICT', 'Черновик изменился. Вариант сохранён отдельно; повторите правку на актуальном черновике.');
    }
    await evidence(candidate);
    let accepted: Site;
    try { accepted = await deps.sites.compareAndSet(site.id, intent.expectedRevision, { draftId: candidate.id }); }
    catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') { candidate.status = 'conflict'; intent.state = 'conflict'; await updateCandidate(candidate); }
      throw error;
    }
    candidate.status = 'accepted'; intent.state = 'completed'; await updateCandidate(candidate);
    return accepted;
  }
  async function settlePublication(intent: PublishIntent): Promise<Site> {
    const site = await deps.sites.get(intent.siteId);
    if (!site) throw new AppError('NOT_FOUND', 'Сайт не найден.');
    const save = () => write(state => { state.publications[state.publications.findIndex(p => p.id === intent.id)] = intent; });
    if (site.publishedId === intent.revisionId && site.revision === intent.expectedRevision + 1) {
      intent.state = 'completed'; await save(); return site;
    }
    if (site.revision !== intent.expectedRevision || site.draftId !== intent.revisionId) {
      intent.state = 'conflict'; await save();
      throw new AppError('CONFLICT', 'Черновик изменился после запроса публикации. Вариант сохранён.');
    }
    const revision = await deps.revisions.get(intent.revisionId);
    if (!revision || revision.siteId !== site.id || revision.manifestId !== intent.manifestId) throw new AppError('INVALID_INPUT', 'Версия публикации не соответствует намерению.');
    const candidate = candidateFor(await read(), site.id, revision.id);
    await evidence(candidate);
    const state = await deps.publication.advance(intent.id);
    if (state !== 'published') throw new AppError(state === 'needs_attention' ? 'NEEDS_ATTENTION' : 'PROVIDER_WAIT', 'Публикация ожидает завершения. Повторите публикацию для проверки результата.');
    let published: Site;
    try { published = await deps.sites.compareAndSet(site.id, intent.expectedRevision, { publishedId: revision.id }); }
    catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') { intent.state = 'conflict'; await save(); }
      throw error;
    }
    intent.state = 'completed'; await save(); return published;
  }
  async function recoverSite(siteId: string) {
    let state = await read();
    for (const candidate of state.candidates.filter(c => c.siteId === siteId)) await syncCandidate(candidate);
    state = await read();
    for (const candidate of state.candidates.filter(c => c.siteId === siteId && c.acceptance?.state === 'pending')) {
      try { await settleAcceptance(candidate); } catch (error) { if (!(error instanceof AppError && error.code === 'CONFLICT')) throw error; }
    }
    // A durable explicit publication intent may resume after restart; an edit alone never creates one.
    for (const intent of state.publications.filter(p => p.siteId === siteId && p.state === 'pending')) {
      try { await settlePublication(intent); } catch (error) { if (!(error instanceof AppError && ['CONFLICT', 'PROVIDER_WAIT', 'NEEDS_ATTENTION'].includes(error.code))) throw error; }
    }
  }
  async function idle(siteId: string) {
    const state = await read();
    const job = await deps.queue.current(siteId);
    if ((job && !['completed', 'cancelled'].includes(job.state)) || state.publications.some(p => p.siteId === siteId && p.state === 'pending') ||
      state.candidates.some(c => c.siteId === siteId && (!terminal.has(c.status) || c.acceptance?.state === 'pending'))) throw new AppError('CONFLICT', busyMessage);
  }
  return {
    recover(siteId: string) { return serial(() => recoverSite(siteId)); },
    requestEdit(actor: Principal, siteId: string, instruction: string, expectedRevision: number, candidateId?: string): Promise<Job> {
      return serial(async () => {
        await siteFor(actor, siteId, 'site:edit');
        if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 8000 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new AppError('INVALID_INPUT', 'Укажите инструкцию до 8000 символов и актуальную версию.');
        await recoverSite(siteId); await idle(siteId);
        const site = await siteFor(actor, siteId, 'site:edit'), state = await read();
        if (site.revision !== expectedRevision) throw new AppError('CONFLICT', 'Сайт изменился. Обновите состояние.');
        const baseDraftId = site.draftId ?? site.publishedId;
        if (!baseDraftId) throw new AppError('CONFLICT', 'Дождитесь первого выпуска сайта.');
        const selected = candidateId ? candidateFor(state, siteId, candidateId) : null;
        if (selected && (selected.status !== 'ready' || selected.baseRevision !== site.revision || selected.baseDraftId !== baseDraftId)) throw new AppError('CONFLICT', 'Этот вариант нельзя уточнить. Повторите правку на актуальном черновике.');
        const parentRevisionId = selected?.id ?? baseDraftId, parent = await deps.revisions.get(parentRevisionId);
        if (!parent || parent.siteId !== siteId) throw new AppError('INVALID_INPUT', 'Базовая версия не найдена.');
        const id = deps.ids.next(), jobId = deps.ids.next(), createdAt = deps.clock.now();
        const message = { id: deps.ids.next(), siteId, candidateId: id, role: 'user' as const, text: instruction.trim(), createdAt };
        const job: Job = { id: jobId, siteId, kind: 'edit', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: selected?.baseRevision ?? site.revision,
          edit: { candidateId: id, baseDraftId, baseManifestId: parent.manifestId, parentRevisionId, instruction: message.text,
            conversation: [...state.messages.filter(m => m.siteId === siteId), message].map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })) } };
        // Existing files remain authoritative; catalog changes affect new sites only.
        const sourceCandidate = selected ?? state.candidates.find(c => c.id === baseDraftId && c.siteId === siteId);
        const sourceJob = await deps.queue.get(sourceCandidate?.jobId ?? siteId);
        if (sourceJob?.checkpointId) {
          const saved = await deps.checkpoints.load(sourceJob.checkpointId), selection = saved.state.selection;
          if (saved.checkpoint.jobId !== sourceJob.id || saved.state.siteId !== siteId || !record(selection) ||
            !Number.isSafeInteger(selection.seed) || typeof selection.styleId !== 'string' || typeof selection.templateVersion !== 'string') throw new AppError('INVALID_INPUT', 'Исходная версия не соответствует заданию.');
          job.generation = { seed: selection.seed as number, styleId: selection.styleId, templateVersion: selection.templateVersion };
        }
        const candidate: Candidate = { id, siteId, jobId, baseRevision: job.baseRevision, baseDraftId, baseManifestId: parent.manifestId,
          parentRevisionId, manifestId: null, status: 'queued', validation: null, summary: '', createdAt, job, acceptance: null };
        await write(state => { state.candidates.push(candidate); state.messages.push(message); });
        await deps.queue.enqueue(job); return job;
      });
    },
    acceptCandidate(actor: Principal, siteId: string, candidateId: string, expectedRevision: number): Promise<Site> {
      return serial(async () => {
        await siteFor(actor, siteId, 'site:edit'); await recoverSite(siteId);
        const candidate = candidateFor(await read(), siteId, candidateId);
        if (candidate.status === 'accepted' && candidate.acceptance?.expectedRevision === expectedRevision) return siteFor(actor, siteId, 'site:edit');
        await idle(siteId);
        const site = await siteFor(actor, siteId, 'site:edit');
        if (candidate.status !== 'ready' || candidate.baseRevision !== expectedRevision || site.revision !== expectedRevision) {
          if (candidate.status === 'ready') { candidate.status = 'conflict'; await updateCandidate(candidate); }
          throw new AppError('CONFLICT', 'Вариант недоступен для принятия. Он сохранён отдельно; повторите правку на актуальном черновике.');
        }
        await evidence(candidate);
        candidate.acceptance = { expectedRevision, state: 'pending' }; await updateCandidate(candidate);
        return settleAcceptance(candidate);
      });
    },
    rejectCandidate(actor: Principal, siteId: string, candidateId: string): Promise<void> {
      return serial(async () => {
        await siteFor(actor, siteId, 'site:edit'); await recoverSite(siteId);
        const candidate = candidateFor(await read(), siteId, candidateId);
        if (candidate.status === 'rejected') return;
        if (candidate.status === 'accepted' || candidate.acceptance?.state === 'pending' || !terminal.has(candidate.status)) throw new AppError('CONFLICT', 'Дождитесь завершения текущей правки. Принятый вариант отклонить нельзя.');
        candidate.status = 'rejected'; await updateCandidate(candidate);
        await deps.queue.cancel(candidate.jobId);
      });
    },
    publish(actor: Principal, siteId: string, expectedRevision: number): Promise<Site> {
      return serial(async () => {
        await siteFor(actor, siteId, 'site:publish'); await recoverSite(siteId);
        const site = await siteFor(actor, siteId, 'site:publish'), state = await read();
        const old = state.publications.find(p => p.siteId === siteId && p.expectedRevision === expectedRevision);
        if (old?.state === 'completed') return site;
        if (old?.state === 'pending') return settlePublication(old);
        await idle(siteId);
        if (site.revision !== expectedRevision || !site.draftId || site.draftId === site.publishedId) throw new AppError('CONFLICT', 'Нет актуального принятого черновика для публикации.');
        const candidate = candidateFor(state, siteId, site.draftId);
        if (candidate.status !== 'accepted' || !candidate.manifestId) throw new AppError('CONFLICT', 'Сначала примите проверенный вариант в черновик.');
        await evidence(candidate);
        const intent: PublishIntent = { id: deps.ids.next(), siteId, revisionId: candidate.id, manifestId: candidate.manifestId, expectedRevision, state: 'pending' };
        await write(state => { state.publications.push(intent); });
        return settlePublication(intent);
      });
    },
    getConversation(actor: Principal, siteId: string) {
      return serial(async () => { await siteFor(actor, siteId, 'site:read'); await recoverSite(siteId); return (await read()).messages.filter(m => m.siteId === siteId).map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })); });
    },
    list(actor: Principal, siteId: string) {
      return serial(async () => {
        await siteFor(actor, siteId, 'site:read'); await recoverSite(siteId);
        const state = await read();
        return { candidates: state.candidates.filter(c => c.siteId === siteId), publication: state.publications.findLast(p => p.siteId === siteId) ?? null };
      });
    },
    screenshotEvidence(actor: Principal, siteId: string, revisionId: string, comparisonCandidateId?: string) {
      return serial(async () => {
        const site = await siteFor(actor, siteId, 'site:read'); await recoverSite(siteId);
        const state = await read(), candidate = state.candidates.find(c => c.siteId === siteId && c.id === revisionId);
        if (!candidate) return null;
        const comparison = state.candidates.find(c => c.siteId === siteId && c.id === comparisonCandidateId);
        const boundBase = comparison && ['ready', 'accepted', 'conflict'].includes(comparison.status) && comparison.parentRevisionId === revisionId;
        if ((!['ready', 'accepted', 'conflict'].includes(candidate.status) && !boundBase) || !candidate.manifestId) throw new AppError('FORBIDDEN', 'Снимок этого варианта недоступен.');
        const revision = await deps.revisions.get(revisionId);
        if (!revision || revision.siteId !== site.id || revision.manifestId !== candidate.manifestId) throw new AppError('FORBIDDEN', 'Версия не соответствует варианту.');
        return { revision, validation: (await evidence(candidate)).report };
      });
    },
  };
}
