import type { PublicationOutcome, PayloadRef } from '../../contracts/src/recovery.js';
import type { Job, Revision, Site } from '../../contracts/src/model.js';
import type { Candidate, PublishIntent } from '../../contracts/src/editing.js';
export const orphanGraceMs = 86400000, detailRetentionMs = 30 * orphanGraceMs;
export function retainedOutcomes(outcomes: PublicationOutcome[], currentRevisionId: string | null): PublicationOutcome[] {
    const settled = outcomes.filter(o => o.settlement === 'settled').sort((a, b) => (b.sequence ?? 0) - (a.sequence ?? 0) || b.settledAt - a.settledAt || b.id.localeCompare(a.id));
    const current = settled.findIndex(o => o.revisionId === currentRevisionId);
    const ordinary = current >= 0 ? [settled[current]!, ...settled.filter((_, i) => i !== current)].slice(0, 6) : settled.slice(0, 6);
    const boundary = ordinary.at(-1), legacyTies = boundary && boundary.sequence === undefined ? settled.filter(o => o.sequence === undefined && o.settledAt === boundary.settledAt && !ordinary.some(k => k.id === o.id)) : [];
    return [...ordinary, ...legacyTies, ...outcomes.filter(o => o.verifiedAt !== null && o.settlement !== 'settled' && o.settlement !== 'cancelled')];
}
export function references(value: unknown, purpose: 'execution' | 'retained'): PayloadRef[] {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return [];
    const s = value as Record<string, unknown>, result: PayloadRef[] = [];
    const add = (kind: PayloadRef['kind'], id: unknown) => { if (typeof id === 'string' && id)
        result.push({ kind, id }); };
    add('artifact', s.manifestId);
    if (purpose === 'execution') {
        add('artifact', s.baseManifestId);
        for (const r of Array.isArray(s.providerRecoveries) ? s.providerRecoveries : [])
            if (r && typeof r === 'object')
                add('checkpoint', (r as Record<string, unknown>).checkpointId);
    }
    const v = s.validation;
    if (v && typeof v === 'object')
        for (const id of Array.isArray((v as Record<string, unknown>).screenshotIds) ? (v as {
            screenshotIds: unknown[];
        }).screenshotIds : [])
            add('screenshot', id);
    const selection = s.selection;
    if (selection && typeof selection === 'object') {
        const p = selection as Record<string, unknown>;
        if (typeof p.styleId === 'string' && typeof p.templateVersion === 'string' && !(p.styleId === 'existing-site' && p.templateVersion === 'existing'))
            add('catalog', p.styleId + '@' + p.templateVersion);
    }
    return [...new Map(result.map(r => [r.kind + ':' + r.id, r])).values()];
}
export interface RetentionState {
    sites: Site[];
    revisions: Revision[];
    jobs: Job[];
    candidates: Candidate[];
    publications: PublishIntent[];
    outcomes: PublicationOutcome[];
    reserved: PayloadRef[];
}
export interface PayloadEdge {
    owner_kind: string;
    owner_id: string;
    purpose: 'execution' | 'retained';
    target_kind: PayloadRef['kind'];
    target_id: string;
}
export function retentionClosure(state: RetentionState, edges: PayloadEdge[], evidence: Set<string>) {
    const protectedIds = new Set<string>(), seen = new Set<string>(), pending = payloadRoots(state);
    const byOwner = new Map<string, PayloadEdge[]>();
    for (const edge of edges) {
        const owner = edge.owner_kind + ':' + edge.owner_id;
        if (!byOwner.has(owner))
            byOwner.set(owner, []);
        byOwner.get(owner)!.push(edge);
    }
    while (pending.length) {
        const { ref, purpose } = pending.pop()!, key = ref.kind + ':' + ref.id;
        if (seen.has(key + ':' + purpose))
            continue;
        seen.add(key + ':' + purpose);
        if (ref.kind !== 'checkpoint' || purpose === 'execution' || !evidence.has(ref.id))
            protectedIds.add(key);
        for (const e of byOwner.get(key) ?? [])
            if (e.purpose === purpose || purpose === 'execution')
                pending.push({ ref: { kind: e.target_kind, id: e.target_id }, purpose });
    }
    return protectedIds;
}
export function payloadRoots(state: RetentionState) {
    const roots: {
        ref: PayloadRef;
        purpose: 'execution' | 'retained';
    }[] = [];
    const revisionById = new Map(state.revisions.map(r => [r.id, r])), candidateById = new Map(state.candidates.map(c => [c.id, c])), jobById = new Map(state.jobs.map(j => [j.id, j])), outcomesBySite = new Map<string, PublicationOutcome[]>();
    for (const o of state.outcomes) {
        if (!outcomesBySite.has(o.siteId))
            outcomesBySite.set(o.siteId, []);
        outcomesBySite.get(o.siteId)!.push(o);
    }
    const add = (kind: PayloadRef['kind'], id: string | null | undefined, purpose: 'execution' | 'retained' = 'retained') => { if (id)
        roots.push({ ref: { kind, id }, purpose }); };
    const revision = (id: string | null) => { const r = id ? revisionById.get(id) : null; if (r)
        add('artifact', r.manifestId); };
    const evidence = (revisionId: string) => { const c = candidateById.get(revisionId), jobId = c?.jobId ?? revisionById.get(revisionId)?.siteId, j = jobId ? jobById.get(jobId) : null; if (j?.checkpointId)
        add('checkpoint', j.checkpointId); };
    for (const site of state.sites) {
        for (const id of [site.publishedId, site.draftId])
            if (id) {
                revision(id);
                evidence(id);
            }
        add('resource', site.input.logoAssetId);
        for (const o of retainedOutcomes(outcomesBySite.get(site.id) ?? [], site.publishedId)) {
            add('artifact', o.manifestId);
            evidence(o.revisionId);
        }
    }
    for (const j of state.jobs)
        if (!['completed', 'cancelled'].includes(j.state)) {
            add('checkpoint', j.checkpointId, 'execution');
            add('artifact', j.edit?.baseManifestId, 'execution');
            add('checkpoint', j.providerRecovery?.checkpointId, 'execution');
        }
    for (const c of state.candidates)
        if (['queued', 'running', 'checking', 'ready', 'conflict'].includes(c.status) || c.acceptance?.state === 'pending' || c.visualSave?.state === 'pending') {
            add('artifact', c.manifestId);
            if (c.status === 'ready')
                add('artifact', c.baseManifestId, 'execution');
            const j = jobById.get(c.jobId);
            if (j?.checkpointId)
                add('checkpoint', j.checkpointId, !['completed', 'cancelled'].includes(j.state) && ['queued', 'running', 'checking'].includes(c.status) ? 'execution' : 'retained');
        }
    for (const p of state.publications)
        if (p.state === 'pending')
            add('artifact', p.manifestId, 'execution');
    for (const ref of state.reserved)
        roots.push({ ref, purpose: 'execution' });
    return roots;
}
