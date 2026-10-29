import {safeTopic} from '../../contracts/src/registry.js';
import { AppError } from '../../contracts/src/model.js';
import type { CheckpointStore, Clock, IdSource, Job, Principal, PublicationPort, Queue, RevisionRepository, Site, SiteRepository, ValidationReport } from '../../contracts/src/model.js';
import type { Candidate, EditingState, EditingStore, PublishIntent } from '../../contracts/src/editing.js';
import { record } from '../../contracts/src/inputs.js';
import { authorize } from './permissions.js';
import type { ArtifactStore, Revision } from '../../contracts/src/model.js';
import { elementPatch } from '../../contracts/src/visual.js';
import type { ElementPatch, VisualProducer, VisualSave, SaveView } from '../../contracts/src/visual.js';
import { createEditableMap, digest } from './visual/editable-map.js';
import { completeVisualAcceptance, failVisualAcceptance, type VisualAcceptanceReceipt } from './visual/acceptance.js';
export interface EditingDeps {
    artifacts?: ArtifactStore;
    visualCompareAndSet?: (actorId: string, siteId: string, expectedRevision: number, draftId: string) => Promise<Site>;
    visualAcceptance?: (candidate: Candidate) => Promise<VisualAcceptanceReceipt>;
    sites: SiteRepository;
    store: EditingStore;
    revisions: RevisionRepository;
    checkpoints: CheckpointStore;
    queue: Queue & {
        get(id: string): Promise<Job | null>;
        current(siteId: string): Promise<Job | null>;
        cancel(id: string): Promise<void>;
    };
    publication: PublicationPort;
    handoffPublication?: (intent: PublishIntent) => Promise<Site>;
    canRollback?: (siteId: string, revisionId: string) => Promise<boolean>;
    clock: Clock;
    ids: IdSource;
}
const terminal = new Set(['ready', 'accepted', 'rejected', 'conflict', 'failed']);
const busyMessage = 'Дождитесь завершения или отмените текущую правку.';
export function visualSaveHash(expectedRevision: number, mapId: string, patch: ElementPatch) { return digest(JSON.stringify([expectedRevision, mapId, patch.elementId, patch.text ?? null, patch.href ?? null, patch.imageAssetId ?? null, Object.entries(patch.styles ?? {}).sort()])); }
/** Checkpoint errors are private provider data: expose only a short, redacted first-line diagnostic. */
function safeDiagnostic(value: unknown): string | null {
    if (typeof value !== 'string')
        return null;
    const text = value.slice(0, 8192)
        .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/gi, '[скрыто]')
        // Semicolons separate cookies/attributes within a header, not independent diagnostics.
        .replace(/\b(?:cookie|set-cookie)\b["']?\s*[:=][^\r\n]*/gi, '[скрыто]')
        .replace(/\b(?:authorization|proxy-authorization)\b["']?\s*[:=][^\r\n;]*/gi, '[скрыто]')
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
    let store = deps.store;
    function serial<T>(siteId: string, action: () => Promise<T>): Promise<T> {
        const result = tail.then(() => { store = deps.store.forSite?.(siteId) ?? deps.store; return action(); });
        tail = result.catch(() => undefined);
        return result;
    }
    const read = () => store.transaction(state => ({ result: structuredClone(state) }));
    const write = (change: (state: EditingState) => void) => store.transaction(state => { change(state); return { value: state, result: undefined }; });
    async function siteFor(actor: Principal, siteId: string, action: 'site:read' | 'site:edit' | 'site:publish') {
        const site = await deps.sites.get(siteId);
        if (!site)
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        authorize(actor, action, site);
        return site;
    }
    function candidateFor(state: EditingState, siteId: string, candidateId: string) {
        const candidate = state.candidates.find(c => c.id === candidateId && c.siteId === siteId);
        if (!candidate)
            throw new AppError('NOT_FOUND', 'Вариант не найден.');
        return candidate;
    }
    async function updateCandidate(candidate: Candidate) {
        await write(state => { const index = state.candidates.findIndex(c => c.id === candidate.id); state.candidates[index] = candidate; });
    }
    async function evidence(candidate: Candidate) {
        const job = await deps.queue.get(candidate.jobId);
        if (!job?.checkpointId)
            throw new AppError('NOT_FOUND', 'Проверка варианта ещё не готова.');
        const saved = await (deps.checkpoints.evidence?.(job.checkpointId) ?? deps.checkpoints.load(job.checkpointId)), state = saved.state;
        if (saved.checkpoint.jobId !== candidate.jobId || state.jobId !== candidate.jobId || state.siteId !== candidate.siteId ||
            state.baseRevision !== candidate.baseRevision || state.revisionId !== candidate.id || !state.manifestId ||
            saved.checkpoint.manifestId !== state.manifestId || (candidate.manifestId !== null && candidate.manifestId !== state.manifestId) ||
            JSON.stringify(state.visualProducer) !== JSON.stringify(candidate.job.edit?.producer) ||
            !['publication', 'completed'].includes(saved.checkpoint.stage) || !record(state.validation) || state.validation.ok !== true ||
            !Array.isArray(state.validation.issues) || state.validation.issues.length !== 0 || !Array.isArray(state.validation.screenshotIds) ||
            !state.validation.screenshotIds.every(id => typeof id === 'string'))
            throw new AppError('INVALID_INPUT', 'Проверка не соответствует варианту.');
        return { state, report: state.validation as unknown as ValidationReport, manifestId: state.manifestId as string };
    }
    async function failureDiagnostic(candidate: Candidate, job: Job): Promise<string | null> {
        if (!job.checkpointId || job.id !== candidate.jobId || job.siteId !== candidate.siteId || job.kind !== 'edit' ||
            job.baseRevision !== candidate.baseRevision || job.edit?.candidateId !== candidate.id)
            return null;
        try {
            const saved = await deps.checkpoints.load(job.checkpointId), state = saved.state;
            if (saved.checkpoint.id !== job.checkpointId || saved.checkpoint.jobId !== job.id || saved.checkpoint.stage !== job.stage ||
                state.jobId !== job.id || state.siteId !== candidate.siteId || state.baseRevision !== candidate.baseRevision ||
                state.baseManifestId !== candidate.baseManifestId || state.parentRevisionId !== candidate.parentRevisionId ||
                (state.revisionId !== null && state.revisionId !== candidate.id))
                return null;
            return safeDiagnostic(state.error);
        }
        catch {
            // Missing/corrupt diagnostics must not prevent rejecting a failed operation or expose a storage error.
            return null;
        }
    }
    async function syncCandidate(candidate: Candidate) {
        if (candidate.status === 'rejected') {
            const job = await deps.queue.get(candidate.jobId);
            if (job && job.state !== 'cancelled')
                await deps.queue.cancel(job.id);
            return;
        }
        if (terminal.has(candidate.status))
            return;
        let job = await deps.queue.get(candidate.jobId);
        if (!job) {
            await deps.queue.enqueue(candidate.job);
            job = await deps.queue.get(candidate.jobId);
        }
        if (!job)
            throw new AppError('NOT_FOUND', 'Задание не найдено.');
        if (job.state === 'completed') {
            const checked = await evidence(candidate);
            candidate.manifestId = checked.manifestId;
            candidate.validation = checked.report;
            const transcript = checked.state.transcript;
            candidate.summary = candidate.visualSave ? 'Визуальная правка проверена.' : Array.isArray(transcript) && record(transcript.at(-1)) && typeof transcript.at(-1).summary === 'string' ? transcript.at(-1).summary : 'Правка проверена.';
            const site = await deps.sites.get(candidate.siteId);
            candidate.status = site?.revision === candidate.baseRevision ? 'ready' : 'conflict';
            await deps.revisions.put({ id: candidate.id, siteId: candidate.siteId, parentId: candidate.parentRevisionId, manifestId: candidate.manifestId, kind: 'candidate', createdAt: candidate.createdAt });
        }
        else if (job.state === 'needs_attention' || job.state === 'cancelled') {
            candidate.status = job.state === 'cancelled' ? 'rejected' : 'failed';
            const diagnostic = job.state === 'needs_attention' ? await failureDiagnostic(candidate, job) : null;
            candidate.summary = `Правка не завершена.${diagnostic ? ` Причина: ${diagnostic}` : ''} Черновик и публикация сохранены.`;
        }
        else {
            candidate.status = job.state !== 'running' ? 'queued' : ['validate', 'archive', 'publication'].includes(job.stage) ? 'checking' : 'running';
        }
        await write(state => {
            state.candidates[state.candidates.findIndex(c => c.id === candidate.id)] = candidate;
            if (terminal.has(candidate.status) && !state.messages.some(m => m.candidateId === candidate.id && m.role === 'assistant')) {
                state.messages.push({ id: deps.ids.next(), siteId: candidate.siteId, candidateId: candidate.id, role: 'assistant', text: candidate.summary, createdAt: deps.clock.now() });
            }
        });
    }
    async function settleAcceptance(candidate: Candidate): Promise<{
        site: Site;
        journalCommitted?: true;
    } | {
        error: AppError;
        journalCommitted: true;
    }> {
        const intent = candidate.acceptance!;
        if (candidate.visualSave && deps.visualAcceptance) {
            await evidence(candidate);
            const receipt = await deps.visualAcceptance(candidate);
            if (receipt.state === 'failed') {
                Object.assign(candidate, failVisualAcceptance(candidate, receipt.message));
                return { error: new AppError(receipt.code, receipt.message), journalCommitted: true };
            }
            Object.assign(candidate, completeVisualAcceptance(candidate));
            return { site: receipt.site, journalCommitted: true };
        }
        const site = await deps.sites.get(candidate.siteId);
        if (!site)
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        if (site.draftId === candidate.id && site.revision === intent.expectedRevision + 1) {
            candidate.status = 'accepted';
            intent.state = 'completed';
            if (candidate.visualSave)
                candidate.visualSave.state = 'completed';
            await updateCandidate(candidate);
            return { site };
        }
        if (site.revision !== intent.expectedRevision || (site.draftId ?? site.publishedId) !== candidate.baseDraftId) {
            candidate.status = 'conflict';
            intent.state = 'conflict';
            await updateCandidate(candidate);
            throw new AppError('CONFLICT', 'Черновик изменился. Вариант сохранён отдельно; повторите правку на актуальном черновике.');
        }
        await evidence(candidate);
        let accepted: Site;
        try {
            if (candidate.visualSave && !deps.visualCompareAndSet)
                throw new AppError('UNAVAILABLE', 'Проверка доступа к сохранению недоступна.');
            accepted = candidate.visualSave ? await deps.visualCompareAndSet!(candidate.visualSave.actorId, site.id, intent.expectedRevision, candidate.id) : await deps.sites.compareAndSet(site.id, intent.expectedRevision, { draftId: candidate.id });
        }
        catch (error) {
            if (error instanceof AppError && error.code === 'CONFLICT') {
                candidate.status = 'conflict';
                intent.state = 'conflict';
                await updateCandidate(candidate);
            }
            throw error;
        }
        candidate.status = 'accepted';
        intent.state = 'completed';
        if (candidate.visualSave)
            candidate.visualSave.state = 'completed';
        await updateCandidate(candidate);
        return { site: accepted };
    }
    async function settlePublication(intent: PublishIntent): Promise<Site> {
        const site = await deps.sites.get(intent.siteId);
        if (!site)
            throw new AppError('NOT_FOUND', 'Сайт не найден.');
        const save = () => write(state => { state.publications[state.publications.findIndex(p => p.id === intent.id)] = intent; });
        if (site.publishedId === intent.revisionId && site.revision === intent.expectedRevision + 1) {
            intent.state = 'completed';
            await save();
            return site;
        }
        if (site.revision !== intent.expectedRevision || (intent.selection !== 'rollback' && site.draftId !== intent.revisionId)) {
            intent.state = 'conflict';
            await save();
            throw new AppError('CONFLICT', 'Черновик изменился после запроса публикации. Вариант сохранён.');
        }
        const revision = await deps.revisions.get(intent.revisionId);
        if (!revision || revision.siteId !== site.id || revision.manifestId !== intent.manifestId)
            throw new AppError('INVALID_INPUT', 'Версия публикации не соответствует намерению.');
        if (intent.selection === 'rollback') {
            if (!await deps.canRollback?.(site.id, revision.id))
                throw new AppError('CONFLICT', 'Историческая версия недоступна для отката.');
            if (!deps.artifacts)
                throw new AppError('UNAVAILABLE', 'Хранилище не подключено.');
            await deps.artifacts.read(revision.manifestId);
        }
        else {
            const candidate = candidateFor(await read(), site.id, revision.id);
            await evidence(candidate);
        }
        if (deps.handoffPublication)
            return deps.handoffPublication(intent);
        const state = await deps.publication.advance(intent.id);
        if (state !== 'published')
            throw new AppError(state === 'needs_attention' ? 'NEEDS_ATTENTION' : 'PROVIDER_WAIT', 'Публикация ожидает завершения. Повторите публикацию для проверки результата.');
        let published: Site;
        try {
            published = deps.sites.settlePublication ? await deps.sites.settlePublication(site.id, intent.expectedRevision, { publishedId: revision.id }, { id: intent.id, siteId: site.id, revisionId: revision.id, manifestId: revision.manifestId, settledAt: deps.clock.now(), verifiedAt: null, settlement: 'settled', origin: intent.selection === 'rollback' ? 'rollback' : 'draft', mode: 'demo' }) : await deps.sites.compareAndSet(site.id, intent.expectedRevision, { publishedId: revision.id });
        }
        catch (error) {
            if (error instanceof AppError && error.code === 'CONFLICT') {
                intent.state = 'conflict';
                await save();
            }
            throw error;
        }
        intent.state = 'completed';
        await save();
        return published;
    }
    async function recoverSite(siteId: string) {
        let state = await read();
        for (const candidate of state.candidates.filter(c => c.siteId === siteId))
            await syncCandidate(candidate);
        state = await read();
        for (const candidate of state.candidates.filter(c => c.siteId === siteId && c.visualSave?.state === 'pending')) {
            if (candidate.status === 'accepted') {
                candidate.visualSave!.state = 'completed';
                await updateCandidate(candidate);
                continue;
            }
            if (candidate.status === 'ready' || candidate.acceptance?.state === 'pending') {
                candidate.acceptance ??= { expectedRevision: candidate.baseRevision, state: 'pending' };
                await updateCandidate(candidate);
                try {
                    const outcome = await settleAcceptance(candidate);
                    if (outcome.journalCommitted)
                        return candidate;
                }
                catch (error) {
                    if (!(error instanceof AppError && ['CONFLICT', 'FORBIDDEN', 'NOT_FOUND'].includes(error.code)))
                        throw error;
                    candidate.visualSave!.state = 'failed';
                    candidate.visualSave!.error = error.code === 'CONFLICT' ? 'Черновик изменился; сохранённый вариант доступен отдельно.' : 'Доступ к сохранению отозван.';
                    candidate.acceptance.state = 'conflict';
                    candidate.status = 'conflict';
                    await updateCandidate(candidate);
                }
            }
            else if (['failed', 'rejected', 'conflict'].includes(candidate.status)) {
                candidate.visualSave!.state = 'failed';
                candidate.visualSave!.error = candidate.summary || 'Визуальная правка не прошла проверку.';
                await updateCandidate(candidate);
            }
        }
        state = await read();
        for (const candidate of state.candidates.filter(c => c.siteId === siteId && c.acceptance?.state === 'pending')) {
            try {
                const outcome = await settleAcceptance(candidate);
                if ('error' in outcome)
                    throw outcome.error;
            }
            catch (error) {
                if (!(error instanceof AppError && error.code === 'CONFLICT'))
                    throw error;
            }
        }
        // A durable explicit publication intent may resume after restart; an edit alone never creates one.
        for (const intent of state.publications.filter(p => p.siteId === siteId && p.state === 'pending')) {
            try {
                await settlePublication(intent);
            }
            catch (error) {
                if (!(error instanceof AppError && ['CONFLICT', 'PROVIDER_WAIT', 'NEEDS_ATTENTION'].includes(error.code)))
                    throw error;
            }
        }
    }
    async function idle(siteId: string) {
        const state = await read();
        const job = await deps.queue.current(siteId);
        if ((job && !['completed', 'cancelled'].includes(job.state)) || state.publications.some(p => p.siteId === siteId && p.state === 'pending') ||
            state.candidates.some(c => c.siteId === siteId && (!terminal.has(c.status) || c.acceptance?.state === 'pending')))
            throw new AppError('CONFLICT', busyMessage);
    }
    const api = {
        async rollback(actor: Principal, siteId: string, revisionId: string, expectedRevision: number): Promise<PublishIntent> {
            return serial(siteId, async () => { await siteFor(actor, siteId, 'site:publish'); await recoverSite(siteId); await idle(siteId); const site = await siteFor(actor, siteId, 'site:publish'); if (site.revision !== expectedRevision)
                throw new AppError('CONFLICT', 'Версия изменилась.'); const revision = await deps.revisions.get(revisionId); if (!revision || revision.siteId !== siteId || !await deps.canRollback?.(siteId, revisionId))
                throw new AppError('CONFLICT', 'Историческая версия недоступна для отката.'); const intent: PublishIntent = { id: deps.ids.next(), siteId, revisionId, manifestId: revision.manifestId, expectedRevision, state: 'pending', selection: 'rollback' }; await write(state => { state.publications.push(intent); }); await settlePublication(intent); return intent; });
        },
        async visualMap(actor: Principal, siteId: string, expectedRevision: number) {
            const site = await siteFor(actor, siteId, 'site:edit');
            if (site.revision !== expectedRevision)
                throw new AppError('CONFLICT', 'Черновик изменился.');
            const revision = await deps.revisions.get(site.draftId ?? site.publishedId ?? '');
            if (!revision || revision.siteId !== site.id || !deps.artifacts)
                throw new AppError('NOT_FOUND', 'Исходная версия недоступна.');
            const state = await (deps.store.forSite?.(siteId) ?? deps.store).transaction(s => ({ result: s }));
            const previous = state.candidates.find(c => c.id === revision.id && c.status === 'accepted')?.job.edit?.producer;
            const files = await deps.artifacts.read(revision.manifestId);
            return { files, map: createEditableMap(files, { siteId, revisionId: revision.id, manifestId: revision.manifestId, ...(previous ? { lineage: previous.binding.lineage } : {}) }) };
        },
        async requestVisual(actor: Principal, siteId: string, expectedRevision: number, input: ElementPatch, mapId: string, requestKey: string): Promise<Job> {
            await siteFor(actor, siteId, 'site:edit');
            const patch = elementPatch(input);
            if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 100 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
                throw new AppError('INVALID_INPUT', 'Недопустимый запрос сохранения.');
            const payloadHash = visualSaveHash(expectedRevision, mapId, patch);
            const old = await (deps.store.forSite?.(siteId) ?? deps.store).transaction(s => ({ result: s.candidates.find(c => c.siteId === siteId && c.visualSave?.actorId === actor.userId && c.visualSave.requestKey === requestKey) }));
            if (old) {
                if (old.visualSave!.payloadHash !== payloadHash)
                    throw new AppError('CONFLICT', 'Ключ сохранения уже использован.');
                return old.job;
            }
            const { map } = await api.visualMap(actor, siteId, expectedRevision);
            if (map.binding.mapId !== mapId || !map.nodes.has(patch.elementId))
                throw new AppError('CONFLICT', 'Карта исходника устарела.');
            return api.requestEdit(actor, siteId, 'Визуальная правка', expectedRevision, undefined, { producer: { kind: 'visual', version: 1, binding: map.binding, patch }, save: { actorId: actor.userId, requestKey, payloadHash, state: 'pending' } });
        },
        visualStatus(actor: Principal, siteId: string, saveId: string): Promise<SaveView> {
            return serial(siteId, async () => {
                await siteFor(actor, siteId, 'site:read');
                const committed = await recoverSite(siteId);
                await siteFor(actor, siteId, 'site:read');
                const c = committed?.id === saveId ? committed : candidateFor(await read(), siteId, saveId);
                if (!c.visualSave)
                    throw new AppError('NOT_FOUND', 'Сохранение не найдено.');
                const revision = c.visualSave.state === 'completed' ? await deps.revisions.get(c.id) : null;
                return { saveId: c.id, status: c.visualSave.state === 'pending' ? c.status : c.visualSave.state, ...(revision ? { revision } : {}), ...(c.visualSave.error ? { error: c.visualSave.error } : {}) };
            });
        },
        recover(siteId: string) { return serial(siteId, () => recoverSite(siteId)); },
        requestEdit(actor: Principal, siteId: string, instruction: string, expectedRevision: number, candidateId?: string, visual?: {
            producer: VisualProducer;
            save: VisualSave;
        }): Promise<Job> {
            return serial(siteId, async () => {
                await siteFor(actor, siteId, 'site:edit');
                if (visual) {
                    const old = (await read()).candidates.find(c => c.siteId === siteId && c.visualSave?.actorId === actor.userId && c.visualSave.requestKey === visual.save.requestKey);
                    if (old) {
                        if (old.visualSave!.payloadHash !== visual.save.payloadHash)
                            throw new AppError('CONFLICT', 'Ключ сохранения уже использован.');
                        return old.job;
                    }
                }
                if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 8000 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
                    throw new AppError('INVALID_INPUT', 'Укажите инструкцию до 8000 символов и актуальную версию.');
                await recoverSite(siteId);
                await idle(siteId);
                const site = await siteFor(actor, siteId, 'site:edit'), state = await read();
                if (site.revision !== expectedRevision)
                    throw new AppError('CONFLICT', 'Сайт изменился. Обновите состояние.');
                const baseDraftId = site.draftId ?? site.publishedId;
                if (!baseDraftId)
                    throw new AppError('CONFLICT', 'Дождитесь первого выпуска сайта.');
                const selected = candidateId ? candidateFor(state, siteId, candidateId) : null;
                if (selected && (selected.status !== 'ready' || selected.baseRevision !== site.revision || selected.baseDraftId !== baseDraftId))
                    throw new AppError('CONFLICT', 'Этот вариант нельзя уточнить. Повторите правку на актуальном черновике.');
                const parentRevisionId = selected?.id ?? baseDraftId, parent = await deps.revisions.get(parentRevisionId);
                if (!parent || parent.siteId !== siteId)
                    throw new AppError('INVALID_INPUT', 'Базовая версия не найдена.');
                const id = deps.ids.next(), jobId = deps.ids.next(), createdAt = deps.clock.now();
                const message = { id: deps.ids.next(), siteId, candidateId: id, role: 'user' as const, text: instruction.trim(), createdAt };
                const job: Job = { id: jobId, siteId, kind: 'edit', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: selected?.baseRevision ?? site.revision,
                    edit: { ...(visual ? { producer: visual.producer } : {}), candidateId: id, baseDraftId, baseManifestId: parent.manifestId, parentRevisionId, instruction: message.text,
                        conversation: [...state.messages.filter(m => m.siteId === siteId), message].map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })) } };
                // Existing files remain authoritative; catalog changes affect new sites only.
                const sourceCandidate = selected ?? state.candidates.find(c => c.id === baseDraftId && c.siteId === siteId);
                const sourceJob = await deps.queue.get(sourceCandidate?.jobId ?? siteId);
                if (sourceJob?.checkpointId) {
                    const saved = await (deps.checkpoints.evidence?.(sourceJob.checkpointId) ?? deps.checkpoints.load(sourceJob.checkpointId)), selection = saved.state.selection;
                    if (saved.checkpoint.jobId !== sourceJob.id || saved.state.siteId !== siteId || !record(selection) ||
                        !Number.isSafeInteger(selection.seed) || typeof selection.styleId !== 'string' || typeof selection.templateVersion !== 'string')
                        throw new AppError('INVALID_INPUT', 'Исходная версия не соответствует заданию.');
                    const topic=safeTopic(saved.state.topic??saved.state.brief);
                    job.generation = { seed: selection.seed as number, styleId: selection.styleId, templateVersion: selection.templateVersion,...(topic?{topic}:{}) };
                }
                const candidate: Candidate = { id, siteId, jobId, baseRevision: job.baseRevision, baseDraftId, baseManifestId: parent.manifestId,
                    parentRevisionId, manifestId: null, status: 'queued', validation: null, summary: '', createdAt, job, acceptance: null, ...(visual ? { visualSave: visual.save } : {}) };
                await write(state => { state.candidates.push(candidate); state.messages.push(message); });
                await deps.queue.enqueue(job);
                return job;
            });
        },
        acceptCandidate(actor: Principal, siteId: string, candidateId: string, expectedRevision: number): Promise<Site> {
            return serial(siteId, async () => {
                await siteFor(actor, siteId, 'site:edit');
                await recoverSite(siteId);
                const candidate = candidateFor(await read(), siteId, candidateId);
                if (candidate.status === 'accepted' && candidate.acceptance?.expectedRevision === expectedRevision)
                    return siteFor(actor, siteId, 'site:edit');
                await idle(siteId);
                const site = await siteFor(actor, siteId, 'site:edit');
                if (candidate.status !== 'ready' || candidate.baseRevision !== expectedRevision || site.revision !== expectedRevision) {
                    if (candidate.status === 'ready') {
                        candidate.status = 'conflict';
                        await updateCandidate(candidate);
                    }
                    throw new AppError('CONFLICT', 'Вариант недоступен для принятия. Он сохранён отдельно; повторите правку на актуальном черновике.');
                }
                await evidence(candidate);
                candidate.acceptance = { expectedRevision, state: 'pending' };
                await updateCandidate(candidate);
                const outcome = await settleAcceptance(candidate);
                if ('error' in outcome)
                    throw outcome.error;
                return outcome.site;
            });
        },
        rejectCandidate(actor: Principal, siteId: string, candidateId: string): Promise<void> {
            return serial(siteId, async () => {
                await siteFor(actor, siteId, 'site:edit');
                await recoverSite(siteId);
                const candidate = candidateFor(await read(), siteId, candidateId);
                if (candidate.status === 'rejected')
                    return;
                if (candidate.status === 'accepted' || candidate.acceptance?.state === 'pending' || !terminal.has(candidate.status))
                    throw new AppError('CONFLICT', 'Дождитесь завершения текущей правки. Принятый вариант отклонить нельзя.');
                candidate.status = 'rejected';
                await updateCandidate(candidate);
                await deps.queue.cancel(candidate.jobId);
            });
        },
        publish(actor: Principal, siteId: string, expectedRevision: number): Promise<Site> {
            return serial(siteId, async () => {
                await siteFor(actor, siteId, 'site:publish');
                await recoverSite(siteId);
                const site = await siteFor(actor, siteId, 'site:publish'), state = await read();
                const old = state.publications.find(p => p.siteId === siteId && p.expectedRevision === expectedRevision);
                if (old?.state === 'completed')
                    return site;
                if (old?.state === 'pending')
                    return settlePublication(old);
                await idle(siteId);
                if (site.revision !== expectedRevision || !site.draftId || site.draftId === site.publishedId)
                    throw new AppError('CONFLICT', 'Нет актуального принятого черновика для публикации.');
                const candidate = candidateFor(state, siteId, site.draftId);
                if (candidate.status !== 'accepted' || !candidate.manifestId)
                    throw new AppError('CONFLICT', 'Сначала примите проверенный вариант в черновик.');
                await evidence(candidate);
                const intent: PublishIntent = { id: deps.ids.next(), siteId, revisionId: candidate.id, manifestId: candidate.manifestId, expectedRevision, state: 'pending' };
                await write(state => { state.publications.push(intent); });
                return settlePublication(intent);
            });
        },
        getConversation(actor: Principal, siteId: string) {
            return serial(siteId, async () => { await siteFor(actor, siteId, 'site:read'); await recoverSite(siteId); return (await read()).messages.filter(m => m.siteId === siteId).map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt })); });
        },
        list(actor: Principal, siteId: string) {
            return serial(siteId, async () => {
                await siteFor(actor, siteId, 'site:read');
                await recoverSite(siteId);
                const state = await read();
                return { candidates: state.candidates.filter(c => c.siteId === siteId), publication: state.publications.findLast(p => p.siteId === siteId) ?? null };
            });
        },
        screenshotEvidence(actor: Principal, siteId: string, revisionId: string, comparisonCandidateId?: string) {
            return serial(siteId, async () => {
                const site = await siteFor(actor, siteId, 'site:read');
                await recoverSite(siteId);
                const state = await read(), candidate = state.candidates.find(c => c.siteId === siteId && c.id === revisionId);
                if (!candidate)
                    return null;
                const comparison = state.candidates.find(c => c.siteId === siteId && c.id === comparisonCandidateId);
                const boundBase = comparison && ['ready', 'accepted', 'conflict'].includes(comparison.status) && comparison.parentRevisionId === revisionId;
                if ((!['ready', 'accepted', 'conflict'].includes(candidate.status) && !boundBase) || !candidate.manifestId)
                    throw new AppError('FORBIDDEN', 'Снимок этого варианта недоступен.');
                const revision = await deps.revisions.get(revisionId);
                if (!revision || revision.siteId !== site.id || revision.manifestId !== candidate.manifestId)
                    throw new AppError('FORBIDDEN', 'Версия не соответствует варианту.');
                return { revision, validation: (await evidence(candidate)).report };
            });
        },
    };
    return api;
}
