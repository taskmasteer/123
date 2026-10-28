import type { PostgresQueue } from './postgres-queue.js';
import type { R2Store } from './r2-store.js';
import type { VercelClient } from './vercel/client.js';
import type { verifyPublicHttps } from './public-https.js';
import type { PublicationView } from '../../contracts/src/publication.js';
import type { DomainSetup, PublicationReceipt } from '../../contracts/src/publication.js';
import type { Manifest, Revision, PublicationState, Principal } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
import { randomUUID } from 'node:crypto';
import { manifestHash, digest, publisherConfiguration, publisherPolicyVersion, publicationHeaders, deploymentFiles } from '../../core/src/publication.js';
import { createDeployment, promoteDeployment, type ProviderBinding } from './vercel/publish.js';
import { uploadFile } from './vercel/upload.js';
import { findDeploymentPage, matchesDeployment } from './vercel/reconcile.js';
import { domainSetup } from './vercel/domains.js';
import { VercelError } from './vercel/client.js';
import type { SqlTransaction } from './supabase-repository.js';
import { authorize } from '../../core/src/permissions.js';
import { createEditing } from '../../core/src/editing.js';
import type { Lease } from '../../contracts/src/model.js';
type Action = 'project' | 'project_create' | 'domain' | 'domain_attach' | 'verify_domain' | 'dns' | 'upload' | 'create' | 'find' | 'check' | 'promote' | 'alias' | 'https' | 'settle';
interface Progress {
    action: Action;
    dispatched: boolean;
    projectId: string | null;
    projectName: string;
    domain: string;
    uploaded: number;
    cursor: number | null;
    matches: string[];
    promotionSent: boolean;
    projectDomain?: any;
    domainSetup: DomainSetup;
    revision: Revision;
    policyVersion: string;
    policyHash: string;
}
const mutations = new Set<Action>(['project_create', 'domain_attach', 'verify_domain', 'upload', 'create', 'promote']);
const phaseFor: Record<Action, PublicationState> = { project: 'pending', project_create: 'pending', domain: 'pending', domain_attach: 'pending', verify_domain: 'awaiting_dns', dns: 'awaiting_dns', upload: 'uploading', create: 'creating', find: 'reconciling', check: 'checking', promote: 'promoting', alias: 'reconciling', https: 'reconciling', settle: 'reconciling' };
export class PostgresPublication {
    constructor(readonly queue: PostgresQueue, readonly store: R2Store, readonly client: VercelClient, readonly verify: typeof verifyPublicHttps) { }
    get repo() { return this.queue.repository; }
    async requestPublication(actor: Principal, siteId: string, revisionId: string, expectedRevision: number, requestKey: string): Promise<PublicationView> {
        await this.repo.transaction(async (tx) => { authorize(await this.repo.fresh(tx, actor), 'site:publish', (await this.repo.get(siteId, tx))!); });
        const existing = (await this.repo.pool.query('select id,binding,site_id from private.publication_reservations where request_key=$1', [requestKey])).rows[0];
        if (existing) {
            if (existing.site_id !== siteId || existing.binding.revisionId !== revisionId || existing.binding.expectedRevision !== expectedRevision)
                throw new AppError('CONFLICT', 'Ключ запроса уже использован.');
            return this.attach(existing.id, requestKey);
        }
        const admission = await this.repo.acquire(actor, siteId);
        try {
            const site = (await this.repo.get(siteId))!;
            if (site.draftId !== revisionId || site.revision !== expectedRevision)
                throw new AppError('CONFLICT', 'Принятый черновик изменился.');
            let publicationId: string | undefined;
            const editing = createEditing({ sites: { create: (input, a) => this.repo.create(input, a), get: id => this.repo.get(id), list: (a, c, l) => this.repo.list(a, c, l), compareAndSet: (id, rev, patch) => this.repo.compareAndSet(id, rev, patch, admission) },
                store: this.repo.editingStore(admission), revisions: { get: id => this.repo.revision(id), put: r => this.repo.putRevision(r, admission) }, queue: this.repo.queue(admission), checkpoints: this.store,
                publication: { advance: async () => { throw new AppError('UNAVAILABLE', 'Требуется серверная передача.'); } }, clock: { now: Date.now }, ids: { next: () => requestKey },
                handoffPublication: async (intent) => {
                    if (intent.id !== requestKey || intent.revisionId !== revisionId)
                        throw new AppError('CONFLICT', 'Продолжите существующую публикацию.');
                    const reservation = await this.repo.transaction(tx => this.queue.reserveControllerPublication(tx, admission, requestKey, { revisionId: intent.revisionId, manifestId: intent.manifestId, expectedRevision: intent.expectedRevision }));
                    publicationId = reservation.id;
                    await this.attach(reservation.id, intent.id);
                    return (await this.repo.get(siteId))!;
                } });
            await editing.publish(actor, siteId, expectedRevision);
            if (!publicationId)
                throw new AppError('CONFLICT', 'Версия уже опубликована.');
            return this.view(publicationId);
        }
        finally {
            await this.repo.release(admission);
        }
    }
    async authorizeResume(actor: Principal, siteId: string, id: string) {
        await this.repo.transaction(async (tx) => {
            const r = await this.lockReservation(tx, id);
            if (r.site_id !== siteId)
                throw new AppError('NOT_FOUND', 'Публикация не найдена.');
            const fresh = await this.repo.fresh(tx, actor), site = (await this.repo.get(siteId, tx))!;
            authorize(fresh, r.origin_job_id ? 'site:read' : 'site:publish', site);
            if (r.origin_job_id && fresh.role !== 'admin' && site.ownerId !== fresh.userId)
                throw new AppError('FORBIDDEN', 'Можно продолжить только собственную генерацию.');
        });
    }
    async receipt(workerId: string, lease: Lease): Promise<PublicationReceipt | null> {
        return this.repo.transaction(async (tx) => {
            const job = (await tx.query('select * from private.jobs where id=$1', [lease.jobId])).rows[0];
            if (!job || job.last_worker_id !== workerId || lease.workerId !== workerId || Number(job.generation) !== lease.generation)
                throw new AppError('STALE_LEASE', 'Чужое задание.');
            const worker = (await tx.query('select revoked_at from private.workers where id=$1 for share', [workerId])).rows[0];
            if (!worker || worker.revoked_at)
                throw new AppError('STALE_LEASE', 'Устройство отозвано.');
            const r = (await tx.query("select r.* from private.publication_reservations r join private.provider_publications p on p.id=r.id where r.origin_job_id=$1 and r.resolution='settled' and p.settlement='settled' and p.verified_at is not null", [job.id])).rows[0];
            if (!r)
                return null;
            const site = (await this.repo.get(job.site_id, tx))!, revision = await this.repo.revision(r.binding.revisionId, tx);
            if (site.publishedId !== r.binding.revisionId || site.revision !== r.binding.expectedRevision + 1 || !revision || revision.manifestId !== r.binding.manifestId || revision.siteId !== site.id || job.checkpoint_id !== r.binding.checkpointId)
                throw new AppError('CONFLICT', 'Опубликованная версия уже изменилась.');
            return { jobId: job.id, siteId: site.id, ...r.binding };
        });
    }
    /** Reservations are a discoverable attachment outbox. No worker lease, caller
     * replay key or external HTTP is needed to recover their authorized binding. */
    async attach(id: string, editingIntentId?: string | null): Promise<PublicationView> {
        const r = (await this.repo.pool.query('select * from private.publication_reservations where id=$1', [id])).rows[0];
        if (!r)
            throw new AppError('NOT_FOUND', 'Публикация не найдена.');
        const attached = (await this.repo.pool.query('select account_id,editing_intent_id from private.provider_publications where id=$1', [id])).rows[0];
        if (attached) {
            if (attached.account_id !== this.client.options.accountId || (editingIntentId !== undefined && attached.editing_intent_id !== (editingIntentId?.toLowerCase() ?? null)))
                throw new AppError('CONFLICT', 'Настройки публикации изменились.');
            return this.view(id); // Never reload bytes or replace an existing frozen ledger.
        }
        const preparing = await this.repo.transaction(async (tx) => {
            const current = await this.lockReservation(tx, id);
            if ((await tx.query('select id from private.provider_publications where id=$1', [id])).rowCount)
                return false;
            const operation = (await tx.query('select kind,operation_id from private.site_operations where site_id=$1', [r.site_id])).rows[0];
            if (current.resolution || operation?.kind !== 'publication' || operation.operation_id !== id)
                throw new AppError('CONFLICT', 'Владение публикацией изменилось.');
            // Commit before any fallible preparation: a crash or unavailable R2
            // cannot make this oldest orphan monopolize the next machine tick.
            await tx.query("update private.publication_reservations set attachment_retry_at=clock_timestamp()+interval '15 seconds' where id=$1", [id]);
            return true;
        });
        if (!preparing)
            return this.attach(id, editingIntentId);
        let journalId: string | null = null;
        if (r.origin_controller_id) {
            const journal = (await this.repo.pool.query('select id,data from private.deployments where id::text=lower($1) and site_id=$2', [r.request_key, r.site_id])).rows[0];
            const intent = journal?.data;
            if (!intent || intent.id !== r.request_key || intent.siteId !== r.site_id || intent.revisionId !== r.binding.revisionId || intent.manifestId !== r.binding.manifestId || intent.expectedRevision !== r.binding.expectedRevision || intent.state !== 'pending')
                throw new AppError('CONFLICT', 'Журнал не соответствует переданной публикации.');
            journalId = journal.id;
        }
        if (editingIntentId !== undefined && (editingIntentId?.toLowerCase() ?? null) !== journalId)
            throw new AppError('CONFLICT', 'Журнал публикации изменился.');
        editingIntentId = journalId;
        let revision = await this.repo.revision(r.binding.revisionId);
        if (r.origin_job_id) {
            const saved = await this.store.load(r.binding.checkpointId);
            if (saved.state.revisionId !== r.binding.revisionId || saved.state.manifestId !== r.binding.manifestId || saved.checkpoint.jobId !== r.origin_job_id || !Number.isSafeInteger(saved.state.revisionCreatedAt))
                throw new AppError('CONFLICT', 'Снимок публикации изменился.');
            revision = { id: r.binding.revisionId, siteId: r.site_id, manifestId: r.binding.manifestId, parentId: saved.state.parentRevisionId as string | null, kind: 'published', createdAt: saved.state.revisionCreatedAt as number };
        }
        if (!revision || revision.siteId !== r.site_id || revision.manifestId !== r.binding.manifestId)
            throw new AppError('CONFLICT', 'Версия публикации не найдена.');
        const manifest = (await this.repo.pool.query('select manifest from private.artifacts where id=$1 and site_id=$2 and verified', [r.binding.manifestId, r.site_id])).rows[0]?.manifest as Manifest | undefined;
        if (!manifest)
            throw new AppError('CONFLICT', 'Артефакт не проверен.');
        const hash = manifestHash(manifest), site = (await this.repo.get(r.site_id))!;
        const progress: Progress = { action: 'project', dispatched: false, projectId: null, projectName: 'sf-' + site.id, domain: site.domain, uploaded: 0, cursor: null, matches: [], promotionSent: false, domainSetup: { records: [], verified: false }, revision, policyVersion: publisherPolicyVersion, policyHash: digest(publisherConfiguration.bytes) };
        await this.repo.transaction(async (tx) => {
            const current = await this.lockReservation(tx, id);
            if (!(await tx.query('select id from private.provider_publications where id=$1', [id])).rowCount) {
                const operation = (await tx.query('select kind,operation_id from private.site_operations where site_id=$1', [r.site_id])).rows[0];
                if (current.resolution || operation?.kind !== 'publication' || operation.operation_id !== id)
                    throw new AppError('CONFLICT', 'Владение публикацией изменилось.');
            }
            await tx.query('insert into private.provider_accounts(id) values($1) on conflict do nothing', [this.client.options.accountId]);
            await tx.query('insert into private.provider_publications(id,site_id,revision_id,manifest_id,manifest_hash,account_id,editing_intent_id,data) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do nothing', [id, site.id, revision.id, manifest.id, hash, this.client.options.accountId, editingIntentId, progress]);
            const existing = (await tx.query('select * from private.provider_publications where id=$1', [id])).rows[0];
            if (existing.manifest_hash !== hash || existing.account_id !== this.client.options.accountId || existing.editing_intent_id !== editingIntentId)
                throw new AppError('CONFLICT', 'Настройки публикации изменились.');
            await tx.query('update private.publication_reservations set attachment_retry_at=null where id=$1', [id]);
        });
        return this.view(id);
    }
    private async lockReservation(tx: SqlTransaction, id: string) {
        const r = (await tx.query('select * from private.publication_reservations where id=$1', [id])).rows[0];
        if (!r)
            throw new AppError('NOT_FOUND', 'Публикация не найдена.');
        await tx.query('select id from public.sites where id=$1 for update', [r.site_id]);
        if (r.origin_job_id) {
            await tx.query('select w.id from private.workers w where w.id in (select worker_id from private.jobs where id=$1 union select last_worker_id from private.jobs where id=$1) order by w.id for update', [r.origin_job_id]);
            await tx.query('select id from private.jobs where id=$1 for update', [r.origin_job_id]);
        }
        await tx.query('select site_id from private.site_operations where site_id=$1 for update', [r.site_id]);
        return (await tx.query('select * from private.publication_reservations where id=$1 for update', [id])).rows[0];
    }
    async view(id: string): Promise<PublicationView> {
        const r = (await this.repo.pool.query('select *,floor(extract(epoch from retry_at)*1000)::text retry from private.provider_publications where id=$1', [id])).rows[0];
        if (!r)
            throw new AppError('NOT_FOUND', 'Публикация не найдена.');
        return { id: r.id, siteId: r.site_id, revisionId: r.revision_id, manifestId: r.manifest_id, manifestHash: r.manifest_hash, deploymentId: r.deployment_id, phase: r.phase, retryAt: r.retry === null ? null : Number(r.retry), cancelRequested: r.cancel_requested, settlement: r.settlement, verifiedAt: r.verified_at === null ? null : Number(r.verified_at), origin: r.editing_intent_id ? 'draft' : 'generation' };
    }
    async getDomainSetup(siteId: string): Promise<DomainSetup> { const latest = await this.latest(siteId); return latest ? (await this.repo.pool.query('select data from private.provider_publications where id=$1', [latest.id])).rows[0].data.domainSetup : { records: [], verified: false }; }
    async latest(siteId: string) {
        const r = (await this.repo.pool.query('select r.id,p.id is not null attached from private.publication_reservations r left join private.provider_publications p on p.id=r.id where r.site_id=$1 and (r.resolution is null or p.id is not null) order by (r.resolution is null) desc,r.created_at desc,r.id limit 1', [siteId])).rows[0];
        return r ? r.attached ? this.view(r.id) : this.attach(r.id) : null;
    }
    async history(siteId: string) { return Promise.all((await this.repo.pool.query('select id from private.provider_publications where site_id=$1 and verified_at is not null order by verified_at desc,id', [siteId])).rows.map(r => this.view(r.id))); }
    private async claim(id: string) {
        return this.repo.transaction(async (tx) => {
            const reservation = await this.lockReservation(tx, id);
            const r = (await tx.query('select *,step_expires>clock_timestamp() busy,retry_at>clock_timestamp() waiting from private.provider_publications where id=$1 for update', [id])).rows[0];
            if (!r || r.settlement !== 'pending' || r.busy || r.waiting)
                return null;
            if (r.account_id !== this.client.options.accountId)
                throw new AppError('CONFLICT', 'Изменился аккаунт публикации.');
            const p = r.data as Progress;
            const job = reservation.origin_job_id ? (await tx.query('select data from private.jobs where id=$1', [reservation.origin_job_id])).rows[0]?.data : null;
            r.cancel_requested ||= job?.state === 'cancelled';
            if (r.cancel_requested && p.action === 'upload')
                p.dispatched = false;
            if (p.dispatched) {
                if (p.action === 'create') {
                    p.action = 'find';
                    p.cursor = null;
                    p.matches = [];
                }
                else if (p.action === 'promote') {
                    p.action = 'alias';
                    p.promotionSent = true;
                }
                else if (p.action === 'project_create')
                    p.action = 'project';
                else if (p.action === 'domain_attach' || p.action === 'verify_domain')
                    p.action = 'domain';
                // dispatched stays true for unknown project/domain; absence must not recreate.
            }
            // A known accepted deployment can still be building. Keep its account slot
            // until checking observes a terminal state; cancellation must not overbook it.
            if (r.cancel_requested && !p.promotionSent && !p.dispatched && p.action !== 'find' && !(p.action === 'check' && r.deployment_id)) {
                await this.queue.settlePublicationInTransaction(tx, id, 'cancelled');
                await tx.query("update private.provider_publications set cancel_requested=true,settlement='cancelled',phase='needs_attention' where id=$1", [id]);
                await tx.query('update private.provider_accounts set active_intent=null where active_intent=$1', [id]);
                return null;
            }
            const account = (await tx.query('select *,step_expires>clock_timestamp() busy,blocked_until>clock_timestamp() blocked from private.provider_accounts where id=$1 for update', [r.account_id])).rows[0];
            if (account.busy)
                return null;
            const creates = Number((await tx.query("select count(*) from private.publication_attempts where account_id=$1 and action='create' and dispatched_at>clock_timestamp()-interval '24 hours'", [r.account_id])).rows[0].count);
            const count = Number(account.request_count), windowExpired = (await tx.query("select $1::timestamptz<=clock_timestamp()-interval '1 minute' expired", [account.request_window])).rows[0].expired;
            if (account.blocked || (!windowExpired && count >= 60) || (p.action === 'create' && (creates >= 100 || (account.active_intent && account.active_intent !== id)))) {
                await tx.query("update private.provider_publications set phase='waiting_quota',retry_at=clock_timestamp()+interval '1 minute' where id=$1", [id]);
                return null;
            }
            const token = randomUUID();
            if (p.action === 'create')
                await tx.query('update private.provider_accounts set active_intent=$2 where id=$1', [r.account_id, id]);
            await tx.query("update private.provider_accounts set step_token=$2,step_expires=clock_timestamp()+interval '40 seconds',request_count=case when $3 then 1 else request_count+1 end,request_window=case when $3 then clock_timestamp() else request_window end where id=$1", [r.account_id, token, windowExpired]);
            if (mutations.has(p.action)) {
                p.dispatched = true;
                if (p.action === 'promote')
                    p.promotionSent = true;
                await tx.query('insert into private.publication_attempts(id,intent_id,account_id,action) values($1,$2,$3,$4)', [token, id, r.account_id, p.action]);
            }
            await tx.query("update private.provider_publications set step_token=$2,step_expires=clock_timestamp()+interval '40 seconds',data=$3,phase=$4,cancel_requested=$5 where id=$1", [id, token, p, phaseFor[p.action], r.cancel_requested]);
            return { ...r, data: p, token, reservation };
        });
    }
    /** One bounded server step, including dispatch journaling before external I/O. */
    async advancePublication(id: string): Promise<PublicationState> {
        await this.attach(id);
        const claimed = await this.claim(id);
        if (!claimed)
            return (await this.view(id)).phase;
        const p = claimed.data as Progress, action = p.action;
        let phase: PublicationState = phaseFor[action], retryMs = 0, releaseCapacity = false, evidence: any = null;
        const next = (a: Action) => { p.action = a; p.dispatched = false; phase = phaseFor[a]; };
        const binding: ProviderBinding = { id, siteId: claimed.site_id, revisionId: claimed.revision_id, manifestHash: claimed.manifest_hash, projectId: p.projectId ?? '', projectName: p.projectName };
        const projectPath = `/v9/projects/${encodeURIComponent(p.projectId ?? p.projectName)}`;
        try {
            if (p.policyVersion !== publisherPolicyVersion || p.policyHash !== digest(publisherConfiguration.bytes))
                throw new Error('Frozen publisher policy unavailable.');
            switch (action) {
                case 'project':
                case 'project_create': {
                    let project;
                    try {
                        project = action === 'project' ? await this.client.call('GET', projectPath) : await this.client.call('POST', '/v11/projects', { name: p.projectName, framework: null, buildCommand: '', installCommand: '' });
                    }
                    catch (error) {
                        if (error instanceof VercelError && error.status === 404 && action === 'project' && !p.dispatched) {
                            next('project_create');
                            break;
                        }
                        throw error;
                    }
                    if (project?.name !== p.projectName || typeof project.id !== 'string' || project.accountId !== claimed.account_id || project.framework !== null || project.buildCommand !== '' || project.installCommand !== '')
                        throw new Error('Project configuration mismatch.');
                    p.projectId = project.id;
                    next('domain');
                    break;
                }
                case 'domain':
                case 'domain_attach': {
                    try {
                        p.projectDomain = await this.client.call(action === 'domain' ? 'GET' : 'POST', action === 'domain' ? `${projectPath}/domains/${encodeURIComponent(p.domain)}` : `/v10/projects/${encodeURIComponent(p.projectId!)}/domains`, action === 'domain' ? undefined : { name: p.domain });
                    }
                    catch (error) {
                        if (error instanceof VercelError && error.status === 404 && action === 'domain' && !p.dispatched) {
                            next('domain_attach');
                            break;
                        }
                        throw error;
                    }
                    if (p.projectDomain?.name !== p.domain)
                        throw new Error('Domain mismatch.');
                    next('dns');
                    break;
                }
                case 'dns': {
                    const config = await this.client.call('GET', `/v6/domains/${encodeURIComponent(p.domain)}/config?projectIdOrName=${encodeURIComponent(p.projectId!)}`);
                    p.domainSetup = domainSetup(p.domain, p.projectDomain, config);
                    if (!p.domainSetup.verified) {
                        next(p.projectDomain.verified ? 'domain' : 'verify_domain');
                        phase = 'awaiting_dns';
                        retryMs = 30000;
                    }
                    else
                        next(p.uploaded ? claimed.deployment_id ? 'check' : 'upload' : 'upload');
                    break;
                }
                case 'verify_domain': {
                    const domain = await this.client.call('POST', `${projectPath}/domains/${encodeURIComponent(p.domain)}/verify`);
                    if (domain?.name !== p.domain || typeof domain.verified !== 'boolean')
                        throw new Error('Domain verification mismatch.');
                    p.projectDomain = domain;
                    next('dns');
                    if (!domain.verified)
                        retryMs = 30000;
                    break;
                }
                case 'upload': {
                    const manifest = await this.manifest(claimed), envelope = deploymentFiles(manifest), entry = envelope[p.uploaded];
                    if (!entry) {
                        next('create');
                        break;
                    }
                    const file = entry.file === 'vercel.json' ? publisherConfiguration : (await this.store.read(manifest.id)).find(f => f.path === entry.file)!;
                    await uploadFile(this.client, file, entry.sha, entry.size);
                    p.uploaded++;
                    next(p.uploaded === envelope.length ? 'create' : 'upload');
                    break;
                }
                case 'create': {
                    const deployment = await createDeployment(this.client, binding, await this.manifest(claimed));
                    if (!matchesDeployment(deployment, binding))
                        throw new Error('Deployment binding mismatch.');
                    claimed.deployment_id = deployment.id ?? deployment.uid;
                    next('check');
                    break;
                }
                case 'find': {
                    const page = await findDeploymentPage(this.client, binding, p.cursor);
                    p.matches = [...new Set([...p.matches, ...page.matches])];
                    p.cursor = page.next;
                    if (p.matches.length > 1) {
                        phase = 'needs_attention';
                        retryMs = 60000;
                    }
                    else if (page.next === null) {
                        if (p.matches.length === 1) {
                            claimed.deployment_id = p.matches[0];
                            next('check');
                        }
                        else {
                            phase = 'needs_attention';
                            retryMs = 60000;
                            p.cursor = null;
                        }
                    }
                    break;
                }
                case 'check': {
                    const deployment = await this.client.call('GET', `/v13/deployments/${encodeURIComponent(claimed.deployment_id)}`);
                    if (!matchesDeployment(deployment, binding))
                        throw new Error('Deployment binding mismatch.');
                    if (deployment.readyState === 'READY') {
                        releaseCapacity = true;
                        next('promote');
                    }
                    else if (['ERROR', 'CANCELED'].includes(deployment.readyState)) {
                        releaseCapacity = true;
                        if (claimed.cancel_requested)
                            next('promote');
                        else {
                            phase = 'needs_attention';
                            retryMs = 60000;
                        }
                    }
                    else
                        retryMs = 3000;
                    break;
                }
                case 'promote':
                    await promoteDeployment(this.client, p.projectId!, claimed.deployment_id);
                    next('alias');
                    break;
                case 'alias': {
                    const alias = await this.client.call('GET', `/v4/aliases/${encodeURIComponent(p.domain)}`);
                    if (alias?.alias !== p.domain || alias.projectId !== p.projectId || alias.deploymentId !== claimed.deployment_id) {
                        phase = 'reconciling';
                        retryMs = 5000;
                    }
                    else
                        next('https');
                    break;
                }
                case 'https': {
                    const file = (await this.manifest(claimed)).files.find(f => f.path === 'index.html')!;
                    const observed = await this.verify({ hostname: p.domain, path: '/index.html', sha256: file.sha256, size: file.size, mediaType: file.mediaType, headers: publicationHeaders });
                    evidence = { ...observed, hostname: p.domain, deploymentId: claimed.deployment_id, projectId: p.projectId, manifestHash: claimed.manifest_hash, indexSha256: file.sha256, policyHash: p.policyHash };
                    next('settle');
                    break;
                }
                case 'settle': break;
            }
        }
        catch (error) {
            if (error instanceof VercelError && error.status === 429) {
                phase = 'waiting_quota';
                retryMs = error.retryAfter;
                p.dispatched = false;
                if (action === 'promote')
                    p.promotionSent = false;
            }
            else if (mutations.has(action)) {
                phase = 'reconciling';
                retryMs = 1000;
            }
            else {
                phase = action === 'https' ? 'awaiting_dns' : 'needs_attention';
                retryMs = 10000;
            }
        }
        await this.repo.transaction(async (tx) => {
            const reservation = await this.lockReservation(tx, id);
            const current = (await tx.query('select *,step_expires>clock_timestamp() live from private.provider_publications where id=$1 for update', [id])).rows[0];
            const account = (await tx.query('select step_token,step_expires>clock_timestamp() live from private.provider_accounts where id=$1 for update', [claimed.account_id])).rows[0];
            if (current.step_token !== claimed.token || !current.live || account.step_token !== claimed.token || !account.live)
                return; // Both authorities fence late responses.
            await tx.query('update private.provider_accounts set step_token=null,step_expires=null,active_intent=case when $3 and active_intent=$2 then null else active_intent end,blocked_until=case when $4::int>0 then clock_timestamp()+($4::int*interval \'1 millisecond\') else blocked_until end where id=$1 and step_token=$5', [claimed.account_id, id, releaseCapacity, phase === 'waiting_quota' ? retryMs : 0, claimed.token]);
            await tx.query('update private.provider_publications set data=$2,deployment_id=$3,phase=$4,step_token=null,step_expires=null,retry_at=case when $5::int>0 then clock_timestamp()+($5::int*interval \'1 millisecond\') else null end,evidence=coalesce($6::jsonb,evidence),verified_at=coalesce($7::bigint,verified_at) where id=$1', [id, p, claimed.deployment_id, phase, retryMs, evidence, evidence?.verifiedAt ?? null]);
            await tx.query('update private.publication_attempts set result=$2 where id=$1', [claimed.token, p.dispatched ? 'unknown' : 'observed']);
            if (action === 'settle')
                await this.settle(tx, id, reservation, current);
        });
        return (await this.view(id)).phase;
    }
    private async manifest(row: any): Promise<Manifest> {
        const manifest = (await this.repo.pool.query('select manifest from private.artifacts where id=$1 and site_id=$2 and verified', [row.manifest_id, row.site_id])).rows[0]?.manifest;
        if (!manifest || manifestHash(manifest) !== row.manifest_hash)
            throw new Error('Immutable manifest mismatch.');
        return manifest;
    }
    private async settle(tx: SqlTransaction, id: string, reservation: any, row: any) {
        const p = row.data as Progress, site = (await this.repo.get(row.site_id, tx))!;
        const operation = (await tx.query('select * from private.site_operations where site_id=$1', [site.id])).rows[0];
        if (!row.evidence || !row.verified_at || operation?.operation_id !== id || operation.kind !== 'publication' || site.revision !== reservation.binding.expectedRevision) {
            await tx.query("update private.provider_publications set settlement='conflict',phase='needs_attention' where id=$1", [id]);
            return;
        }
        const existing = await this.repo.revision(row.revision_id, tx);
        // jsonb canonicalizes object key order; immutable identity is field equality.
        if (existing && (['id', 'siteId', 'parentId', 'manifestId', 'kind', 'createdAt'] as const).some(key => existing[key] !== p.revision[key]))
            throw new AppError('CONFLICT', 'Неизменяемая версия изменилась.');
        if (!existing)
            await tx.query('insert into public.revisions values($1,$2,$3,$4,$5,$6)', [p.revision.id, p.revision.siteId, p.revision.parentId, p.revision.manifestId, p.revision.kind, p.revision.createdAt]);
        await tx.query("update public.sites set published_id=$2,revision=revision+1,generation_status='completed',domain_status='verified' where id=$1", [site.id, row.revision_id]);
        if (row.editing_intent_id)
            await tx.query("update private.deployments set data=jsonb_set(data,'{state}','\"completed\"') where id=$1", [row.editing_intent_id]);
        await this.queue.settlePublicationInTransaction(tx, id, 'settled');
        await tx.query("update private.provider_publications set settlement='settled',phase='published' where id=$1", [id]);
    }
    async tick(): Promise<void> {
        const due = (await this.repo.pool.query("select r.id from private.publication_reservations r join private.site_operations o on o.site_id=r.site_id and o.operation_id=r.id and o.kind='publication' left join private.provider_publications p on p.id=r.id where r.resolution is null and ((p.id is null and (r.attachment_retry_at is null or r.attachment_retry_at<=clock_timestamp())) or (p.settlement='pending' and (p.retry_at is null or p.retry_at<=clock_timestamp()) and (p.step_expires is null or p.step_expires<=clock_timestamp()))) order by r.created_at,r.id limit 1")).rows[0];
        if (due)
            await this.advancePublication(due.id);
    }
}
