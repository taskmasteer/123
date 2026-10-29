import { preflightLocal } from './retention-sql.js';import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { opendir, lstat, mkdtemp, rm, rename, copyFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Principal, Site, Job, Revision } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
import { createBackup, restoreBackup } from '../../core/src/backup.js';
import type { BackupEntry } from '../../core/src/backup.js';
import type { RestoreReport } from '../../contracts/src/recovery.js';
import { authorize } from '../../core/src/permissions.js';
import type { LocalDatabase } from './local-database.js';
import { openLocalDatabase } from './local-database.js';
import { privateDirectory, safeFile, readRegular, writeExclusive, missing } from './safe-files.js';
import { portableArchive } from './backup-archive.js';
import { localRecoveryTables, recoveryPath, validateRecovery, readRecoveryRecord, type RecoveryRecord } from './recovery-records.js';
import { createLocalArtifacts } from './local-artifacts.js';
import { createCheckpointStore } from './local-checkpoints.js';
import { verifyValidationPng } from './import-resources.js';
import { projectCheckpoint, parseCheckpointEvidence } from '../../core/src/usage.js';
import { LocalRetention } from './local-retention.js';
import { createLocalCatalog } from './local-catalog.js';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function* files(root: string, prefix = ''): AsyncGenerator<string> {
    for await (const entry of await opendir(await privateDirectory(root, false))) {
        if (entry.name.startsWith('.'))
            continue;
        const path = prefix ? prefix + '/' + entry.name : entry.name;
        recoveryPath(path);
        const info = await lstat(join(root, entry.name));
        if (info.isSymbolicLink())
            throw new AppError('INVALID_INPUT', 'Ссылки запрещены в копии.');
        if (info.isDirectory())
            yield* files(join(root, entry.name), path);
        else if (info.isFile())
            yield path;
        else
            throw new AppError('INVALID_INPUT', 'Необычный файл копии.');
    }
}
export class LocalBackup {
    constructor(readonly db: LocalDatabase, readonly sourceRoot: string, readonly directory: string, readonly quiesce: <T>(capture: () => Promise<T>) => Promise<T> = capture => capture()) { }
    async createBackup(actor: Principal, passphrase: string, signal?:AbortSignal) {
        authorize(actor, 'site:export');
        await new LocalRetention(this.db).backfill(await createCheckpointStore(join(this.db.root, 'checkpoints'), { now: Date.now }));
        preflightLocal(this.db.sql, true);
        await this.verifyPayloads(this.db);
        await this.verifyCatalog(this.db, this.sourceRoot);
        const output = await privateDirectory(this.directory), stage = await mkdtemp(join(output, '.snapshot-')), pin = randomUUID();
        let snapshot: DatabaseSync | undefined;
        try {
            await this.quiesce(async () => {
                preflightLocal(this.db.sql, true);
                this.db.transaction(() => {
                    for (const row of this.db.sql.prepare("select kind,id from payload_inventory where state='available'").iterate())
                        this.db.sql.prepare('insert into payload_pins values(?,?,?,?)').run(pin, String(row.kind), String(row.id), Date.now() + 3600000);
                });
                await this.db.snapshot(stage);
                for (const name of ['catalog-overrides.json'])
                    try {
                        await copyFile(await safeFile(this.db.root, name), join(stage, name));
                    }
                    catch (error) {
                        if (!missing(error))
                            throw error;
                    }
                const plan = await open(join(stage, 'files.ndjson'), 'wx', 0o600);
                try {
                    for (const [root, base, subfolders] of [['data', this.db.root, ['artifacts', 'checkpoints', 'validation']], ['catalog', this.sourceRoot, ['templates', 'references']]] as const)
                        for (const folder of subfolders)
                            try {
                                for await (const relative of files(await privateDirectory(join(base, folder), false)))
                                    await plan.write(JSON.stringify({ root, base, path: folder + '/' + relative }) + '\n');
                            }
                            catch (error) {
                                if (!missing(error))
                                    throw error;
                            }
                }
                finally {
                    await plan.close();
                }
            });
            snapshot = new DatabaseSync(join(stage, 'factory.sqlite'), { readOnly: true, allowExtension: false });
            const frozen = snapshot, source = this.sourceRoot, dataRoot = this.db.root;
            async function* entries(): AsyncGenerator<BackupEntry> {
                let recordIndex = 0, payloadIndex = 0;
                const record = (value: RecoveryRecord) => {
                    signal?.throwIfAborted();
                    const bytes = Buffer.from(JSON.stringify(value));
                    if (bytes.length > 1000000)
                        throw new AppError('INVALID_INPUT', 'Запись превышает ёмкость копии.');
                    return { name: 'records/' + recordIndex++ + '.json', size: bytes.length, sha256: sha(bytes), read: async () => bytes };
                };
                yield record({ type: 'header', version: 1, adapter: 'local', schema: 8, sourceId: pin, createdAt: Date.now() });
                for (const table of localRecoveryTables)
                    for (const saved of frozen.prepare('select * from ' + table + (table === 'operations' ? " where kind<>'controller'" : '')).iterate()) {
                        const row = { ...saved } as Record<string, unknown>;
                        if (table === 'chunks')
                            row.bytes = Buffer.from(row.bytes as Uint8Array).toString('base64');
                        yield record({ type: 'row', table, row });
                    }
                const lines = createInterface({ input: createReadStream(join(stage, 'files.ndjson')), crlfDelay: Infinity });
                try {
                    for await (const line of lines) {
                        const { root, base, path } = JSON.parse(line) as {
                            root: 'data' | 'catalog';
                            base: string;
                            path: string;
                        }, file = await safeFile(base, path), bytes = await readRegular(file, 32000000), name = 'payloads/' + payloadIndex++ + '.bin';
                        yield record({ type: 'file', root, path, payload: name, size: bytes.length, sha256: sha(bytes), mediaType: 'application/octet-stream' });
                        yield { name, size: bytes.length, sha256: sha(bytes), read: () => readRegular(file, 32000000) };
                    }
                }
                finally {
                    lines.close();
                }
                try {
                    const bytes = await readRegular(await safeFile(stage, 'catalog-overrides.json'), 1000000), name = 'payloads/' + payloadIndex++ + '.bin';
                    yield record({ type: 'file', root: 'data', path: 'catalog-overrides.json', payload: name, size: bytes.length, sha256: sha(bytes), mediaType: 'application/json' });
                    yield { name, size: bytes.length, sha256: sha(bytes), read: async () => bytes };
                }
                catch (error) {
                    if (!missing(error))
                        throw error;
                }
            }
            return await createBackup(actor, passphrase, { admin: async (a) => authorize(a, 'site:export'), snapshot: async () => ({ entries: entries(), release: async () => { } }), archive: portableArchive(output), handle: async (file) => file, discard: file => rm(file, { force: true }) });
        }
        finally {
            snapshot?.close();
            this.db.transaction(() => this.db.sql.prepare('delete from payload_pins where id=?').run(pin));
            await rm(stage, { recursive: true, force: true });
        }
    }
    async restoreBackup(actor: Principal, path: string, passphrase: string, targetRoot: string): Promise<RestoreReport> { return restoreBackup(actor, path, passphrase, targetRoot, { admin: async (a) => authorize(a, 'site:export'), archive: portableArchive(this.directory), validate: async (verified) => { await validateRecovery(verified.entries, 'local'); }, install: (verified, target) => this.restoreVerified(actor, verified, target), dispose: verified => rm(verified.directory, { recursive: true, force: true }) }); }
    async restoreVerified(actor: Principal, archive: {
        directory: string;
        entries: import('../../core/src/backup.js').RestoreEntries;
    }, targetRoot: string): Promise<RestoreReport> {
        authorize(actor, 'site:export');
        let stage: string | undefined, db: LocalDatabase | undefined;
        try {
            const { rows, payloads, header } = await validateRecovery(archive.entries, 'local');
            try {
                await lstat(targetRoot);
                throw new AppError('CONFLICT', 'Целевая папка должна быть новой.');
            }
            catch (error) {
                if (!missing(error))
                    throw error;
            }
            const parent = await privateDirectory(join(targetRoot, '..'), false);
            stage = await mkdtemp(join(parent, '.restored-'));
            db = await openLocalDatabase(stage);
            for (const entry of rows) {
                const record = await readRecoveryRecord(entry);
                if (record.type === 'file') {
                    if (record.root === 'object')
                        throw new AppError('INVALID_INPUT', 'Неверное хранилище файла.');
                    if (record.root === 'data' && !/^(artifacts\/manifests\/|checkpoints\/|validation\/|catalog-overrides\.json$)/.test(record.path))
                        throw new AppError('INVALID_INPUT', 'Неизвестный файл копии.');
                    if (record.root === 'catalog' && !/^(templates|references)\//.test(record.path))
                        throw new AppError('INVALID_INPUT', 'Неизвестный каталог копии.');
                    const base = record.root === 'catalog' ? await privateDirectory(join(stage, '.catalog')) : stage;
                    await copyFile(payloads.get(record.payload)!.file, await safeFile(base, record.path, true));
                }
            }
            // Private staging root is not active; bounded batches do no filesystem work under SQL locks.
            db.transaction(() => {
                for (const table of [...localRecoveryTables].reverse())
                    db!.sql.prepare('delete from ' + table).run();
            });
            let batch: Extract<RecoveryRecord, {
                type: 'row';
            }>[] = [], batchBytes = 0;
            const flush = () => {
                if (!batch.length)
                    return;
                db!.transaction(() => {
                    for (const record of batch) {
                        const columns = db!.sql.prepare('pragma table_info(' + record.table + ')').all().map(c => String(c.name));
                        if (Object.keys(record.row).some(k => !columns.includes(k)))
                            throw new AppError('INVALID_INPUT', 'Неизвестное поле копии.');
                        const values = columns.map(c => record.table === 'chunks' && c === 'bytes' ? Buffer.from(String(record.row[c]), 'base64') : record.row[c] ?? null);
                        db!.sql.prepare('insert into ' + record.table + '(' + columns.join(',') + ') values(' + columns.map(() => '?').join(',') + ')').run(...values as (string | number | null | Uint8Array)[]);
                    }
                });
                batch = [];
                batchBytes = 0;
            };
            for (const entry of rows) {
                const record = await readRecoveryRecord(entry);
                if (record.type !== 'row')
                    continue;
                if (record.table === 'recovery_state')
                    record.row.key = 'provenance:' + header.sourceId + ':' + String(record.row.key);
                batch.push(record);
                batchBytes += entry.size;
                if (batch.length >= 50 || batchBytes >= 4000000)
                    flush();
            }
            flush();
            const badRevision = db.sql.prepare("select 1 from records r left join sites s on s.id=r.site_id left join records p on p.kind='revisions' and p.id=json_extract(r.data,'$.parentId') and p.site_id=r.site_id where r.kind='revisions' and (s.id is null or (json_extract(r.data,'$.parentId') is not null and p.id is null)) limit 1").get(), badSite = db.sql.prepare("select 1 from sites s left join records d on d.kind='revisions' and d.id=json_extract(s.data,'$.draftId') and d.site_id=s.id left join records p on p.kind='revisions' and p.id=json_extract(s.data,'$.publishedId') and p.site_id=s.id where (json_extract(s.data,'$.draftId') is not null and d.id is null) or (json_extract(s.data,'$.publishedId') is not null and p.id is null) limit 1").get(), badJob = db.sql.prepare('select 1 from jobs j left join sites s on s.id=j.site_id where s.id is null limit 1').get();
            if (badRevision || badSite || badJob)
                throw new AppError('INVALID_INPUT', 'Связи копии повреждены.');
            const siteCount = Number(db.sql.prepare('select count(*) n from sites').get()?.n), revisionCount = Number(db.sql.prepare("select count(*) n from records where kind='revisions'").get()?.n), sourceUsers = db.sql.prepare('select distinct owner_id from sites').all().map(r => String(r.owner_id)), restoredAt = Date.now();
            db.transaction(() => {
                for (const row of db!.sql.prepare('select id,data,lease,generation from jobs').iterate()) {
                    const job = JSON.parse(String(row.data)) as Job, next = { ...job, state: ['completed', 'cancelled'].includes(job.state) ? job.state : 'paused' as const };
                    db!.sql.prepare('insert into recovery_state values(?,?)').run('job:' + job.id, JSON.stringify({ sourceState: job.state, lease: row.lease, generation: row.generation }));
                    db!.sql.prepare('update jobs set state=?,data=?,lease=null,generation=generation+1 where id=?').run(next.state, JSON.stringify(next), job.id);
                }
                db!.sql.prepare('delete from payload_pins').run();
                db!.sql.prepare('insert into recovery_state values(?,?)').run('quarantine', JSON.stringify({ sourceId: header.sourceId, restoredAt, providerReconciliationRequired: true }));
            });
            await this.verifyPayloads(db);
            await this.verifyCatalog(db, join(db.root, '.catalog'));
            await db.close();
            db = undefined;
            const validated = await openLocalDatabase(stage);
            await validated.close();
            await rename(stage, targetRoot);
            stage = undefined;
            return { restoredSites: siteCount, restoredRevisions: revisionCount, targetId: targetRoot, quarantined: true, sourceUsers, stagedRemnants: [] };
        }
        finally {
            await db?.close();
            if (stage)
                await rm(stage, { recursive: true, force: true });
            await rm(archive.directory, { recursive: true, force: true });
        }
    }
    private async verifyCatalog(db: LocalDatabase, sourceRoot: string) { try {
        const catalog = await createLocalCatalog(sourceRoot, db.root), installed = await catalog.list();
        for (const style of installed.styles)
            await catalog.load(style.id, style.version);
        for (const key of new LocalRetention(db).protected(Date.now()))
            if (key.startsWith('catalog:')) {
                const value = key.slice(8), separator = value.lastIndexOf('@');
                if (separator < 1)
                    throw new Error('Missing catalog version');
                await catalog.load(value.slice(0, separator), value.slice(separator + 1));
            }
    }
    catch (error) {
        throw new AppError('NEEDS_ATTENTION', 'Полная копия недоступна: точная закреплённая версия шаблона или референсы отсутствуют.', { cause: error });
    } }
    private async verifyPayloads(db: LocalDatabase) {
        for (const saved of db.sql.prepare("select r.id,r.data,p.data inventory from resources r join payload_inventory p on p.kind='resource' and p.id=r.id where p.state='available'").iterate()) {
            const r = JSON.parse(String(saved.data)), p = JSON.parse(String(saved.inventory)), size = db.sql.prepare('select count(*) n,coalesce(sum(length(bytes)),0) size from chunks where resource_id=?').get(String(saved.id))!;
            if (Number(size.n) > 700 || Number(size.size) !== r.size || r.size > 16 * 1024 ** 2 || p.objects.length !== 1 || p.objects[0].size !== r.size || p.objects[0].sha256 !== r.sha256)
                throw new AppError('INVALID_INPUT', 'Опись импорта повреждена.');
            const chunks = db.sql.prepare('select part,bytes from chunks where resource_id=? order by part').all(String(saved.id)), hash = createHash('sha256');
            for (const [i, c] of chunks.entries()) {
                if (c.part !== i)
                    throw new AppError('INVALID_INPUT', 'Фрагмент импорта отсутствует.');
                hash.update(c.bytes as Uint8Array);
            }
            if (hash.digest('hex') !== r.sha256)
                throw new AppError('INVALID_INPUT', 'Хэш импорта не совпадает.');
        }
        const artifacts = await createLocalArtifacts(join(db.root, 'artifacts')), checkpoints = await createCheckpointStore(join(db.root, 'checkpoints'), { now: Date.now });
        for (const row of db.sql.prepare("select distinct json_extract(r.data,'$.manifestId') id from records r left join payload_inventory p on p.kind='artifact' and p.id=json_extract(r.data,'$.manifestId') where r.kind='revisions' and coalesce(p.state,'available') not in ('deleted','claimed')").iterate())
            await artifacts.read(String(row.id));
        for (const row of db.sql.prepare("select id,site_id from payload_inventory where kind='checkpoint' and state='available'").iterate()) {
            const loaded = await checkpoints.load(String(row.id));
            if (loaded.state.jobId !== loaded.checkpoint.jobId || loaded.state.siteId !== row.site_id)
                throw new AppError('INVALID_INPUT', 'Контрольная точка принадлежит другому заданию.');
            const saved = db.sql.prepare('select data from checkpoint_evidence where id=?').get(String(row.id));
            if (saved && parseCheckpointEvidence(JSON.parse(String(saved.data))).digest !== projectCheckpoint(loaded.checkpoint, loaded.state, loaded.files, null).evidence.digest)
                throw new AppError('INVALID_INPUT', 'Свидетельство не соответствует сохранённым байтам.');
        }
        for (const row of db.sql.prepare("select data from payload_inventory where kind='screenshot' and state='available'").iterate()) {
            const p = JSON.parse(String(row.data));
            if (p.objects.length !== 1)
                throw new AppError('INVALID_INPUT', 'Опись снимка повреждена.');
            const f = p.objects[0], bytes = await readRegular(await safeFile(db.root, 'validation/' + f.key), 8000000);
            if (bytes.length !== f.size || sha(bytes) !== f.sha256 || f.mediaType !== 'image/png')
                throw new AppError('INVALID_INPUT', 'Снимок проверки повреждён.');
            verifyValidationPng(bytes);
        }
        for (const key of new LocalRetention(db).protected(Date.now()))
            if (key.startsWith('screenshot:'))
                await readRegular(await safeFile(db.root, key.slice(11)), 8000000);
    }
}
