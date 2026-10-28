import { createHash } from 'node:crypto';
import { createLocalArtifacts } from './local-artifacts.js';
import { verifyValidationPng } from './import-resources.js';
import { AppError } from '../../contracts/src/model.js';
import type { LocalDatabase } from './local-database.js';
import type { PayloadInventory, PublicationOutcome } from '../../contracts/src/recovery.js';
import type { RetentionState, PayloadEdge } from '../../core/src/retention.js';
import { retentionClosure, orphanGraceMs, detailRetentionMs } from '../../core/src/retention.js';
import { randomUUID } from 'node:crypto';
import { rm, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { safeFile, privateDirectory, readRegular, missing } from './safe-files.js';
import { projectCheckpoint } from '../../core/src/usage.js';
import { commitLocalProjection, registerLocalPayload } from './retention-schema.js';
export class LocalRetention {
    constructor(readonly db: LocalDatabase) { }
    async backfill(store: import('../../contracts/src/model.js').CheckpointStore, strict = true) {
        const attempt = async (key: string, action: () => Promise<void>) => { try {
            await action();
            this.db.transaction(() => this.db.sql.prepare('delete from recovery_state where key=?').run('legacy-coverage:' + key));
        }
        catch (error) {
            this.db.transaction(() => this.db.sql.prepare('insert into recovery_state values(?,?) on conflict(key) do update set data=excluded.data').run('legacy-coverage:' + key, JSON.stringify({ coverage: 'unavailable', payload: key, observedAt: Date.now() })));
            if (strict)
                throw new AppError('NEEDS_ATTENTION', 'Полная копия недоступна: историческое содержимое требует проверенного восстановления.', { cause: error });
        } };
        const artifacts = await createLocalArtifacts(join(this.db.root, 'artifacts'));
        for (const [folder, kind] of [['artifacts/manifests', 'artifact'], ['checkpoints', 'checkpoint']] as const)
            try {
                for await (const entry of await opendir(await privateDirectory(join(this.db.root, folder), false))) {
                    const id = kind === 'checkpoint' ? entry.name.replace(/\.json$/, '') : entry.name;
                    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || this.db.sql.prepare('select 1 from payload_inventory where kind=? and id=?').get(kind, id))
                        continue;
                    await attempt(kind + ':' + id, async () => { if (kind === 'artifact' && entry.isDirectory())
                        await artifacts.read(id);
                    else if (kind === 'checkpoint' && entry.isFile())
                        await store.load(id); });
                }
            }
            catch (error) {
                if (!missing(error))
                    throw error;
            }
        try {
            for await (const entry of await opendir(await privateDirectory(join(this.db.root, 'validation'), false))) {
                if (!/^[a-f0-9-]{36}\.png$/.test(entry.name) || !entry.isFile() || this.db.sql.prepare("select 1 from payload_inventory where kind='screenshot' and id=?").get('validation/' + entry.name))
                    continue;
                await attempt('screenshot:validation/' + entry.name, async () => { const bytes = await readRegular(await safeFile(this.db.root, 'validation/' + entry.name), 8000000); verifyValidationPng(bytes); const now = Date.now(), payload: PayloadInventory = { kind: 'screenshot', id: 'validation/' + entry.name, siteId: null, objects: [{ key: entry.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' }], createdAt: now, protectUntil: now + 600000, state: 'available', firstOrphanAt: null, claimToken: null }; this.db.transaction(() => registerLocalPayload(this.db.sql, payload)); });
            }
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
        for (const saved of this.db.sql.prepare("select id,data from resources where not exists(select 1 from payload_inventory p where p.kind='resource' and p.id=resources.id)").all()) {
            await attempt('resource:' + saved.id, async () => { const r = JSON.parse(String(saved.data)); if (r.complete) {
                const bytes = Buffer.concat(this.db.sql.prepare('select bytes from chunks where resource_id=? order by part').all(String(saved.id)).map(c => Buffer.from(c.bytes as Uint8Array)));
                if (bytes.length !== r.size || createHash('sha256').update(bytes).digest('hex') !== r.sha256)
                    throw new Error('Legacy import resource is unavailable.');
            } const now = Date.now(), payload: PayloadInventory = { kind: 'resource', id: String(saved.id), siteId: null, objects: [{ key: 'database:chunks:' + saved.id, size: r.size, sha256: r.sha256, mediaType: r.draftId ? 'image/png' : 'application/octet-stream' }], createdAt: now, protectUntil: now + 600000, state: r.complete ? 'available' : 'staging', firstOrphanAt: null, claimToken: null }; this.db.transaction(() => registerLocalPayload(this.db.sql, payload)); });
        }
        for (const row of this.db.sql.prepare("select p.id from payload_inventory p where p.kind='checkpoint' and p.state='available' and not exists(select 1 from checkpoint_evidence e where e.id=p.id) and (json_extract(p.data,'$.accepted')=1 or exists(select 1 from jobs j where p.id in (json_extract(j.data,'$.checkpointId'),json_extract(j.data,'$.providerRecovery.checkpointId'))))").all()) {
            await attempt('checkpoint:' + row.id, async () => {
                const loaded = await store.load(String(row.id)), stored = this.db.sql.prepare('select data from jobs where id=?').get(loaded.checkpoint.jobId);
                if (!stored)
                    throw new Error('Legacy checkpoint job is missing.');
                const job = JSON.parse(String(stored.data));
                if (loaded.state.siteId !== job.siteId || loaded.checkpoint.jobId !== job.id)
                    throw new Error('Legacy checkpoint ownership is unavailable.');
                const projection = projectCheckpoint(loaded.checkpoint, loaded.state, loaded.files, null), pngs: PayloadInventory[] = [];
                for (const ref of projection.retained)
                    if (ref.kind === 'screenshot' && !this.db.sql.prepare("select 1 from payload_inventory where kind='screenshot' and id=? and site_id is not null").get(ref.id)) {
                        if (!/^validation\/[a-f0-9-]{36}\.png$/.test(ref.id))
                            throw new Error('Legacy validation screenshot path is unknown.');
                        const bytes = await readRegular(await safeFile(this.db.root, ref.id), 8000000);
                        verifyValidationPng(bytes);
                        pngs.push({ kind: 'screenshot', id: ref.id, siteId: job.siteId, objects: [{ key: ref.id.slice(11), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png' }], producer: { jobId: job.id, workerId: 'legacy-local', generation: 0 }, createdAt: loaded.checkpoint.createdAt, protectUntil: Date.now() + 600000, state: 'available', firstOrphanAt: null, claimToken: null });
                    }
                this.db.transaction(() => { const current = this.db.sql.prepare('select data from jobs where id=?').get(job.id), latest = current ? JSON.parse(String(current.data)) : null, marker = this.db.sql.prepare("select json_extract(data,'$.accepted') accepted from payload_inventory where kind='checkpoint' and id=?").get(String(row.id)); if (latest && (latest.checkpointId === row.id || latest.providerRecovery?.checkpointId === row.id || marker?.accepted === 1)) {
                    for (const png of pngs) {
                        registerLocalPayload(this.db.sql, png);
                        this.db.sql.prepare("update payload_inventory set site_id=?,data=json_set(data,'$.siteId',?,'$.producer',json(?)) where kind='screenshot' and id=? and site_id is null").run(png.siteId, png.siteId, JSON.stringify(png.producer), png.id);
                    }
                    commitLocalProjection(this.db.sql, projection, latest.checkpointId === row.id);
                } });
            });
        }
    }
    state(): RetentionState {
        const all = (table: string) => this.db.sql.prepare('select data from ' + table).all().map(r => JSON.parse(String(r.data)));
        const records = (kind: string) => this.db.sql.prepare('select data from records where kind=?').all(kind).map(r => JSON.parse(String(r.data)));
        return { sites: all('sites'), jobs: all('jobs'), revisions: records('revisions'), candidates: records('candidates'), publications: records('publications'), outcomes: all('publication_outcomes') as PublicationOutcome[], reserved: this.db.sql.prepare("select r.id from resources r join batches b on b.id=coalesce(json_extract(r.data,'$.draftId'),r.id) where b.state in ('uploading','preview') or (b.state in ('active','paused') and exists(select 1 from batch_rows br left join jobs j on j.id=br.site_id where br.batch_id=b.id and (br.site_id is null or j.state not in ('completed','cancelled'))))").all().map(r => ({ kind: 'resource' as const, id: String(r.id) })) };
    }
    protected(now: number) {
        const protectedIds = retentionClosure(this.state(), this.db.sql.prepare('select * from payload_edges').all() as unknown as PayloadEdge[], new Set(this.db.sql.prepare('select id from checkpoint_evidence').all().map(r => String(r.id))));
        for (const p of this.db.sql.prepare('select kind,payload_id from payload_pins where expires_at>?').all(now))
            protectedIds.add(p.kind + ':' + p.payload_id);
        return protectedIds;
    }
    private candidates(now: number) {
        const evidenceIds = new Set(this.db.sql.prepare('select id from checkpoint_evidence').all().map(r => String(r.id))), unknownSites = new Set(this.state().jobs.filter(j => j.checkpointId && !evidenceIds.has(j.checkpointId)).map(j => j.siteId));
        const roots = this.protected(now), result: PayloadInventory[] = [];
        for (const root of roots)
            if (root.startsWith('checkpoint:') && !evidenceIds.has(root.slice(11))) {
                const site = this.db.sql.prepare("select site_id from payload_inventory where kind='checkpoint' and id=?").get(root.slice(11))?.site_id;
                if (site)
                    unknownSites.add(String(site));
            }
        for (const row of this.db.sql.prepare("select * from payload_inventory where state in ('available','staging','claimed')").all()) {
            const p = { ...JSON.parse(String(row.data)), state: row.state, firstOrphanAt: row.first_orphan_at, claimToken: row.claim_token } as PayloadInventory;
            if (p.state === 'claimed') {
                result.push(p);
                continue;
            }
            if (roots.has(p.kind + ':' + p.id) || p.protectUntil > now || (p.siteId !== null && unknownSites.has(p.siteId)) || (p.siteId === null && p.kind === 'screenshot' && unknownSites.size > 0) || (p.kind === 'checkpoint' && p.accepted !== false && (p.createdAt + detailRetentionMs > now || (p.accepted === true && !evidenceIds.has(p.id))))) {
                if (p.firstOrphanAt !== null)
                    this.db.sql.prepare('update payload_inventory set first_orphan_at=null where kind=? and id=?').run(p.kind, p.id);
                continue;
            }
            if (p.firstOrphanAt === null) {
                this.db.sql.prepare('update payload_inventory set first_orphan_at=? where kind=? and id=?').run(now, p.kind, p.id);
                continue;
            }
            if (p.firstOrphanAt + orphanGraceMs <= now)
                result.push(p);
        }
        return result;
    }
    async planCleanup(now: number): Promise<{
        deletableManifestIds: string[];
    }> { return this.db.transaction(() => ({ deletableManifestIds: this.candidates(now).filter(p => p.kind === 'artifact').map(p => p.id) })); }
    async collect(now: number): Promise<void> {
        const claim = randomUUID(), claimed = this.db.transaction(() => { const candidates = this.candidates(now); for (const p of candidates)
            if (p.state !== 'claimed') {
                this.db.sql.prepare("update payload_inventory set state='claimed',claim_token=? where kind=? and id=?").run(claim, p.kind, p.id);
                p.claimToken = claim;
            } return candidates; });
        for (const p of claimed) {
            if (p.kind === 'resource') {
                this.db.transaction(() => { this.db.sql.prepare('delete from chunks where resource_id=?').run(p.id); this.db.sql.prepare("update payload_inventory set state='deleted' where kind='resource' and id=? and claim_token=?").run(p.id, p.claimToken); });
                continue;
            }
            const directory = p.kind === 'artifact' ? 'artifacts' : p.kind === 'checkpoint' ? 'checkpoints' : 'validation';
            for (const object of p.objects)
                await rm(await safeFile(join(this.db.root, directory), object.key), { force: true });
            this.db.transaction(() => this.db.sql.prepare("update payload_inventory set state='deleted' where kind=? and id=? and state='claimed' and claim_token=?").run(p.kind, p.id, p.claimToken));
        }
    }
}
