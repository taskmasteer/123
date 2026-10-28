import { materializeLocal, preflightLocal, eligibility } from './retention-sql.js';import { createHash } from 'node:crypto';
import { createLocalArtifacts } from './local-artifacts.js';
import { verifyValidationPng } from './import-resources.js';
import { AppError } from '../../contracts/src/model.js';
import type { LocalDatabase } from './local-database.js';
import type { PayloadInventory } from '../../contracts/src/recovery.js';
import { randomUUID } from 'node:crypto';
import { rm, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { safeFile, privateDirectory, readRegular, missing } from './safe-files.js';
import { projectCheckpoint } from '../../core/src/usage.js';
import { commitLocalProjection, registerLocalPayload } from './retention-schema.js';
function* legacyRows(db: LocalDatabase, query: string) { let after = ''; for (;;) {
    const rows = db.sql.prepare('select * from (' + query + ') where id>? order by id limit 64').all(after);
    if (!rows.length)
        return;
    for (const row of rows) {
        after = String(row.id);
        yield row;
    }
} }
export class LocalRetention {
    constructor(readonly db: LocalDatabase) { }
    async backfill(store: import('../../contracts/src/model.js').CheckpointStore, strict = true) {
        preflightLocal(this.db.sql);
        const attempt = async (key: string, action: () => Promise<void>) => {
            try {
                await action();
                this.db.transaction(() => this.db.sql.prepare('delete from recovery_state where key=?').run('legacy-coverage:' + key));
            }
            catch (error) {
                this.db.transaction(() => this.db.sql.prepare('insert into recovery_state values(?,?) on conflict(key) do update set data=excluded.data').run('legacy-coverage:' + key, JSON.stringify({ coverage: 'unavailable', payload: key, observedAt: Date.now() })));
                if (strict)
                    throw new AppError('NEEDS_ATTENTION', 'Полная копия недоступна: историческое содержимое требует проверенного восстановления.', { cause: error });
            }
        };
        const artifacts = await createLocalArtifacts(join(this.db.root, 'artifacts'));
        for (const [folder, kind] of [['artifacts/manifests', 'artifact'], ['checkpoints', 'checkpoint']] as const)
            try {
                for await (const entry of await opendir(await privateDirectory(join(this.db.root, folder), false))) {
                    const id = kind === 'checkpoint' ? entry.name.replace(/\.json$/, '') : entry.name;
                    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || this.db.sql.prepare('select 1 from payload_inventory where kind=? and id=?').get(kind, id))
                        continue;
                    await attempt(kind + ':' + id, async () => {
                        if (kind === 'artifact' && entry.isDirectory())
                            await artifacts.read(id);
                        else if (kind === 'checkpoint' && entry.isFile())
                            await store.load(id);
                    });
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
        for (const saved of legacyRows(this.db, "select id,data from resources where not exists(select 1 from payload_inventory p where p.kind='resource' and p.id=resources.id)")) {
            await attempt('resource:' + saved.id, async () => {
                const r = JSON.parse(String(saved.data));
                if (r.complete) {
                    const bytes = Buffer.concat(this.db.sql.prepare('select bytes from chunks where resource_id=? order by part').all(String(saved.id)).map(c => Buffer.from(c.bytes as Uint8Array)));
                    if (bytes.length !== r.size || createHash('sha256').update(bytes).digest('hex') !== r.sha256)
                        throw new Error('Legacy import resource is unavailable.');
                }
                const now = Date.now(), payload: PayloadInventory = { kind: 'resource', id: String(saved.id), siteId: null, objects: [{ key: 'database:chunks:' + saved.id, size: r.size, sha256: r.sha256, mediaType: r.draftId ? 'image/png' : 'application/octet-stream' }], createdAt: now, protectUntil: now + 600000, state: r.complete ? 'available' : 'staging', firstOrphanAt: null, claimToken: null };
                this.db.transaction(() => registerLocalPayload(this.db.sql, payload));
            });
        }
        for (const row of legacyRows(this.db, "select p.id from payload_inventory p where p.kind='checkpoint' and p.state='available' and not exists(select 1 from checkpoint_evidence e where e.id=p.id) and (json_extract(p.data,'$.accepted')=1 or exists(select 1 from jobs j where p.id in (json_extract(j.data,'$.checkpointId'),json_extract(j.data,'$.providerRecovery.checkpointId'))))")) {
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
                this.db.transaction(() => {
                    const current = this.db.sql.prepare('select data from jobs where id=?').get(job.id), latest = current ? JSON.parse(String(current.data)) : null, marker = this.db.sql.prepare("select json_extract(data,'$.accepted') accepted from payload_inventory where kind='checkpoint' and id=?").get(String(row.id));
                    if (latest && (latest.checkpointId === row.id || latest.providerRecovery?.checkpointId === row.id || marker?.accepted === 1)) {
                        for (const png of pngs) {
                            registerLocalPayload(this.db.sql, png);
                            this.db.sql.prepare("update payload_inventory set site_id=?,data=json_set(data,'$.siteId',?,'$.producer',json(?)) where kind='screenshot' and id=? and site_id is null").run(png.siteId, png.siteId, JSON.stringify(png.producer), png.id);
                        }
                        commitLocalProjection(this.db.sql, projection, latest.checkpointId === row.id);
                    }
                });
            });
        }
    }
    *protected(now: number): Iterable<string> { materializeLocal(this.db.sql, now); let kind = '', id = ''; while (true) {
        const rows = this.db.sql.prepare("select kind,id from retention_protected where (kind,id)>(?,?) order by kind,id limit 64").all(kind, id);
        if (!rows.length)
            return;
        for (const row of rows) {
            kind = String(row.kind);
            id = String(row.id);
            yield kind + ':' + id;
        }
    } }
    private candidates(now: number) { materializeLocal(this.db.sql, now); const eligible = eligibility(false); this.db.sql.prepare("update payload_inventory as p set first_orphan_at=null where state in ('available','staging') and not (" + eligible + ")").run(now); this.db.sql.prepare("insert into retention_candidates select kind,id from payload_inventory p where state='claimed' or (state in ('available','staging') and (" + eligible + ") and first_orphan_at is not null and first_orphan_at+86400000<=?1)").run(now); this.db.sql.prepare("update payload_inventory as p set first_orphan_at=?1 where state in ('available','staging') and first_orphan_at is null and (" + eligible + ")").run(now); }
    async planCleanup(now: number) { return this.db.transaction(() => { this.candidates(now); return { deletableManifestIds: this.db.sql.prepare("select id from retention_candidates where kind='artifact' order by id").all().map(r => String(r.id)) }; }); }
    async collect(now: number): Promise<void> {
        const claim = randomUUID();
        this.db.transaction(() => { this.candidates(now); this.db.sql.prepare("update payload_inventory set state='claimed',claim_token=? where state<>'claimed' and exists(select 1 from retention_candidates c where c.kind=payload_inventory.kind and c.id=payload_inventory.id)").run(claim); });
        let kind = '', id = '';
        while (true) {
            const page = this.db.sql.prepare("select * from payload_inventory where state='claimed' and (kind,id)>(?,?) order by kind,id limit 64").all(kind, id);
            if (!page.length)
                break;
            for (const row of page) {
                kind = String(row.kind);
                id = String(row.id);
                const p = JSON.parse(String(row.data)) as PayloadInventory;
                if (row.kind !== 'resource') {
                    const directory = p.kind === 'artifact' ? 'artifacts' : p.kind === 'checkpoint' ? 'checkpoints' : 'validation';
                    for (const object of p.objects)
                        await rm(await safeFile(join(this.db.root, directory), object.key), { force: true });
                }
            }
            this.db.transaction(() => { for (const row of page) {
                if (row.kind === 'resource')
                    this.db.sql.prepare('delete from chunks where resource_id=?').run(String(row.id));
                this.db.sql.prepare("update payload_inventory set state='deleted' where kind=? and id=? and state='claimed' and claim_token=?").run(String(row.kind), String(row.id), String(row.claim_token));
            } });
        }
    }
}
