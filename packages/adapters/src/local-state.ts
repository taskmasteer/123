import { randomUUID } from 'node:crypto';
import { AppError } from '../../contracts/src/model.js';
import type { Clock, Site, SiteRepository, SitePatch, Lease } from '../../contracts/src/model.js';
import { nonemptyString, parseSiteInput, parseSitePatch, record } from '../../contracts/src/inputs.js';
import { authorize } from '../../core/src/permissions.js';
import { normalizeDomain } from '../../core/src/sites.js';
import type { EditingStore } from '../../contracts/src/editing.js';
import { sqliteEditing } from './sqlite-editing.js';
import { openLocalDatabase, existingLocalDatabase, insertLocalSite, type LocalDatabase } from './local-database.js';
import { sitePagePrefix, siteFilters, filterBinding, encodeCursor, decodeCursor, type SiteFilters } from '../../core/src/site-pagination.js';
/** Private editor journal; write-ahead intents bridge registry and queue transactions. */
export async function createLocalEditingStore(directory: string, database?: LocalDatabase): Promise<EditingStore> {
    if (process.env.NODE_ENV === 'production')
        throw new AppError('FORBIDDEN', 'Local editing is a demonstration adapter.');
    if (database)
        return sqliteEditing(database);
    const initial = await existingLocalDatabase(directory);
    if (!initial) {
        const db = await openLocalDatabase(directory);
        await db.close();
    }
    let tail: Promise<unknown> = Promise.resolve();
    const scoped = (siteId?: string): EditingStore => ({ forSite: id => scoped(id), transaction(operation) {
            const result = tail.then(async () => {
                const shared = await existingLocalDatabase(directory), db = shared ?? await openLocalDatabase(directory);
                try {
                    return await sqliteEditing(db, siteId).transaction(operation);
                }
                finally {
                    if (!shared)
                        await db.close();
                }
            });
            tail = result.catch(() => { });
            return result;
        } });
    return scoped();
}
export interface LocalState extends SiteRepository {
    close(): Promise<void>;
    workerCompareAndSet(siteId: string, expected: number, patch: SitePatch, lease: Lease): Promise<Site>;
}
interface State {
    version: 1;
    savedAt: number;
    sites: Site[];
}
export function parseState(value: unknown): State {
    if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.savedAt) || !Array.isArray(value.sites)) {
        throw new AppError('INVALID_INPUT', 'Local state is corrupt or uses an unsupported format.');
    }
    const ids = new Set<string>();
    const domains = new Set<string>();
    for (const candidate of value.sites) {
        if (!record(candidate) || !nonemptyString(candidate.id) || !nonemptyString(candidate.ownerId) ||
            typeof candidate.domain !== 'string' || normalizeDomain(candidate.domain) !== candidate.domain ||
            !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0 ||
            !Array.isArray(candidate.assignedUserIds) || !candidate.assignedUserIds.every(nonemptyString) ||
            (candidate.draftId !== null && !nonemptyString(candidate.draftId)) ||
            (candidate.publishedId !== null && !nonemptyString(candidate.publishedId)) ||
            !nonemptyString(candidate.generationStatus) || !nonemptyString(candidate.domainStatus) ||
            parseSiteInput(candidate.input).domain !== candidate.domain || ids.has(candidate.id) || domains.has(candidate.domain)) {
            throw new AppError('INVALID_INPUT', 'Local state contains an invalid or duplicate site.');
        }
        ids.add(candidate.id);
        domains.add(candidate.domain);
    }
    return value as unknown as State;
}
/** Demonstration adapter for one controlling process; not a distributed database.
 * get/compareAndSet are trusted repository primitives: request handlers authorize
 * the principal before using them. list and create receive and enforce a principal.
 */
export async function createLocalState(directory: string, clock: Clock, database?: LocalDatabase): Promise<LocalState> {
    const db = database ?? await openLocalDatabase(directory);
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const run = <T>(action: () => T) => {
        if (closed)
            return Promise.reject(new AppError("CONFLICT", "Local state is closed."));
        const result = tail.then(action);
        tail = result.catch(() => { });
        return result;
    };
    const get = (id: string): Site | null => {
        const r = db.sql.prepare("select data from sites where id=?").get(id);
        if (!r)
            return null;
        const site = JSON.parse(String(r.data)) as Site;
        const assigned = db.sql.prepare('select a.user_id from batch_assignments a join batch_rows r on r.batch_id=a.batch_id where r.site_id=?').all(id).map(r => String(r.user_id));
        return { ...site, assignedUserIds: [...new Set([...site.assignedUserIds, ...assigned])] };
    };
    const saved = () => {
        const t = clock.now();
        if (!Number.isSafeInteger(t))
            throw new AppError("INVALID_INPUT", "Invalid clock.");
        db.sql.prepare("insert into metadata values(?,?) on conflict(key) do update set value=excluded.value").run("savedAt", String(t));
    };
    const cas = (id: string, expected: number, patch: SitePatch, lease?: Lease) => {
        if (lease) {
            if (patch.input || patch.assignedUserIds)
                throw new AppError('FORBIDDEN', 'Worker cannot change input or scope.');
            const job = db.sql.prepare('select * from jobs where id=?').get(lease.jobId), current = job?.lease ? JSON.parse(String(job.lease)) as Lease : null, operation = db.sql.prepare('select operation_id from operations where site_id=?').get(id);
            if (!job || job.site_id !== id || job.state !== 'running' || !current || current.workerId !== lease.workerId || current.generation !== lease.generation || current.jobId !== lease.jobId || Number(job.generation) !== lease.generation || current.expiresAt <= clock.now() || operation?.operation_id !== lease.jobId)
                throw new AppError('STALE_LEASE', 'Worker mutation is fenced.');
        }
        const stored = db.sql.prepare("select data from sites where id=?").get(id);
        const site = stored ? JSON.parse(String(stored.data)) as Site : null;
        if (!site)
            throw new AppError("NOT_FOUND", "Site does not exist.");
        if (site.revision !== expected)
            throw new AppError("CONFLICT", "Site revision has changed.");
        const value = parseSitePatch(patch);
        if (value.input && normalizeDomain(value.input.domain) !== site.domain)
            throw new AppError("INVALID_INPUT", "Site domain is immutable.");
        const next = { ...site, ...value, revision: expected + 1 };
        db.sql.prepare("update sites set data=?,status=? where id=?").run(JSON.stringify(next), next.generationStatus, id);
        saved();
        return next;
    };
    return {
        create(input, actor) {
            return run(() => db.transaction(() => {
                authorize(actor, "site:create");
                const validated = parseSiteInput(input), domain = normalizeDomain(validated.domain);
                if (db.sql.prepare("select id from sites where domain=?").get(domain))
                    throw new AppError("DUPLICATE_DOMAIN", "Domain is already registered.");
                const site: Site = { id: randomUUID(), domain, ownerId: actor.userId, assignedUserIds: [], input: { ...validated, domain }, revision: 0, draftId: null, publishedId: null, generationStatus: "queued", domainStatus: "pending" };
                insertLocalSite(db, site);
                saved();
                return site;
            }));
        },
        get(id) { return run(() => get(id)); },
        list(actor, cursor, limit = 50, filters: SiteFilters = {}) {
            return run(() => {
                authorize(actor, "site:create");
                if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                    throw new AppError("INVALID_INPUT", "Page limit must be 1–100.");
                filters = siteFilters(filters);
                const binding = filterBinding(actor, filters), key = decodeCursor(cursor, binding);
                // Match queue.current() and the displayed job state; stored status is only a no-job fallback.
                const rows = db.sql.prepare(`select s.seq,s.data from sites s where (?='admin' or s.owner_id=? or exists(select 1 from json_each(s.data,'$.assignedUserIds') where value=?) or exists(select 1 from batch_assignments a join batch_rows r on r.batch_id=a.batch_id where r.site_id=s.id and a.user_id=?)) and s.seq>? and (?='' or instr(s.domain,?)>0) and (?='' or coalesce((select j.state from jobs j where j.site_id=s.id order by case when j.state in ('completed','cancelled') then 1 else 0 end,j.seq desc limit 1),s.status)=?) and (?='' or exists(select 1 from batch_rows b where b.batch_id=? and b.site_id=s.id)) order by s.seq limit ?`).all(actor.role, actor.userId, actor.userId, actor.userId, Number(key ?? 0), filters.domain ?? "", filters.domain ?? "", filters.status ?? "", filters.status ?? "", filters.batchId ?? "", filters.batchId ?? "", limit + 1);
                const projected = rows.map(r => ({ seq: r.seq, site: get((JSON.parse(String(r.data)) as Site).id)! }));
                const page = sitePagePrefix(projected, r => r.site, limit);
                return { items: page.map(r => r.site), nextCursor: rows.length > page.length ? encodeCursor(String(page.at(-1)!.seq), binding) : null };
            });
        },
        settlePublication(id: string, expected: number, patch: import('../../contracts/src/model.js').SitePatch, outcome: import('../../contracts/src/recovery.js').PublicationOutcome, lease?: import('../../contracts/src/model.js').Lease) { return run(() => db.transaction(() => { const old = db.sql.prepare('select data from publication_outcomes where id=?').get(outcome.id); if (old) {
            const s = get(id);
            if (!s || s.publishedId !== outcome.revisionId)
                throw new AppError('CONFLICT', 'Публикация изменилась.');
            return s;
        } const next = cas(id, expected, patch, lease); outcome = { ...outcome, sequence: Number(db.sql.prepare("select coalesce(max(json_extract(data,'$.sequence')),0)+1 n from publication_outcomes").get()?.n) }; db.sql.prepare('insert into publication_outcomes values(?,?,?)').run(outcome.id, id, JSON.stringify(outcome)); if (outcome.origin === 'rollback')
            db.sql.prepare('insert into records values(?,?,?,?)').run('audit', outcome.id, id, JSON.stringify({ action: 'rollback', revisionId: outcome.revisionId, intentId: outcome.id, createdAt: outcome.settledAt })); return next; })); },
        compareAndSet(id, expected, patch) { return run(() => db.transaction(() => cas(id, expected, patch))); },
        workerCompareAndSet(id, expected, patch, lease) { return run(() => db.transaction(() => cas(id, expected, patch, lease))); },
        async close() {
            if (closed)
                return;
            closed = true;
            await tail;
            if (!database)
                await db.close();
        }
    };
}
