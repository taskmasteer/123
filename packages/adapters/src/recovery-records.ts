import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { AppError } from '../../contracts/src/model.js';
import type { RestoreEntry, RestoreEntries } from '../../core/src/backup.js';
import { readFile } from 'node:fs/promises';
import { parseCheckpointEvidence } from '../../core/src/usage.js';
import { importLimits } from '../../contracts/src/import.js';
export const localRecoveryTables = ['metadata', 'sites', 'jobs', 'records', 'batches', 'batch_rows', 'batch_assignments', 'operations', 'resources', 'chunks', 'payload_inventory', 'payload_edges', 'checkpoint_evidence', 'job_usage', 'publication_outcomes', 'recovery_state'] as const;
export const managedRecoveryTables = ['public.users', 'public.memberships', 'public.sites', 'public.assignments', 'private.workers', 'private.jobs', 'private.artifacts', 'private.checkpoints', 'public.revisions', 'private.edit_requests', 'public.chat', 'private.deployments', 'public.health', 'private.batches', 'private.batch_rows', 'private.batch_assignments', 'private.import_resources', 'private.import_chunks', 'private.publication_reservations', 'private.site_operations', 'private.provider_accounts', 'private.provider_publications', 'private.publication_attempts', 'private.upload_preparations', 'private.catalog', 'private.audit', 'private.payload_inventory', 'private.payload_edges', 'private.checkpoint_evidence', 'private.job_usage', 'private.recovery_state'] as const;
export type RecoveryRecord = {
    type: 'header';
    version: 1;
    adapter: 'local' | 'managed';
    schema: 8;
    sourceId: string;
    createdAt: number;
    pinnedCatalogs?: string[];
    storedCatalogs?: string[];
    hasInstalledCatalog?: boolean;
} | {
    type: 'row';
    table: string;
    row: Record<string, unknown>;
} | {
    type: 'file';
    root: 'data' | 'catalog' | 'object';
    path: string;
    payload: string;
    size: number;
    sha256: string;
    mediaType: string;
};
export function recoveryPath(path: string) { if (typeof path !== 'string' || path.length > 512 || path.split('/').some(p => !/^[a-z0-9][a-z0-9._@-]*$/i.test(p) || p === '.' || p === '..' || p.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))
    throw new AppError('INVALID_INPUT', 'Небезопасный путь резервной копии.'); return path; }
export function validateLogicalRecoveryRecord(record: RecoveryRecord) {
    if (record.type !== 'row')
        return;
    const row = record.row;
    if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new AppError('INVALID_INPUT', 'Неверная запись метаданных.');
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    if (record.table === 'resources' || record.table === 'private.import_resources') {
        const r = data as Record<string, unknown>;
        if (!r || r.id !== row.id || typeof r.complete !== 'boolean' || !Number.isSafeInteger(r.size) || Number(r.size) < 1 || Number(r.size) > importLimits.sourceBytes || typeof r.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.sha256) || typeof r.name !== 'string' || r.name.length > 200)
            throw new AppError('INVALID_INPUT', 'Импортируемый ресурс повреждён.');
    }
    if (record.table === 'chunks' || record.table === 'private.import_chunks') {
        if (!Number.isSafeInteger(row.part) || Number(row.part) < 0 || Number(row.part) > 699 || typeof row.bytes !== 'string' || (record.table === 'chunks' ? !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.bytes) || row.bytes.length > 32000 : !/^\\x(?:[a-f0-9]{2})*$/i.test(row.bytes) || row.bytes.length > 48002))
            throw new AppError('INVALID_INPUT', 'Фрагмент импорта повреждён.');
    }
    if (record.table.endsWith('checkpoint_evidence')) {
        const evidence = parseCheckpointEvidence(data);
        if (evidence.checkpoint.id !== row.id || evidence.checkpoint.jobId !== row.job_id)
            throw new AppError('INVALID_INPUT', 'Привязка свидетельства копии повреждена.');
    }
    if (record.table.endsWith('job_usage')) {
        const u = data as Record<string, unknown>;
        if (!u || u.version !== 1 || u.jobId !== row.job_id || u.checkpointId !== row.checkpoint_id || !['inputTokens', 'outputTokens', 'uncertainRequests'].every(k => Number.isSafeInteger(u[k]) && Number(u[k]) >= 0) || typeof u.requestPending !== 'boolean' || !['provider', 'demo', 'visual', 'unknown'].includes(String(u.provenance)) || !['known-subtotal', 'unknown'].includes(String(u.coverage)))
            throw new AppError('INVALID_INPUT', 'Проекция использования повреждена.');
    }
    if (record.table.endsWith('payload_inventory')) {
        const p = data as Record<string, any>;
        if (!p || p.kind !== row.kind || p.id !== row.id || p.siteId !== row.site_id || !['artifact', 'checkpoint', 'screenshot', 'resource', 'catalog'].includes(p.kind) || !Array.isArray(p.objects) || p.objects.length > (p.kind === 'catalog' ? 10000 : 101) || !Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.protectUntil) || !['staging', 'available', 'claimed', 'deleted'].includes(String(row.state)))
            throw new AppError('INVALID_INPUT', 'Опись содержимого повреждена.');
        for (const f of p.objects)
            if (!f || typeof f.key !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 32 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.mediaType !== 'string')
                throw new AppError('INVALID_INPUT', 'Физическая опись повреждена.');
    }
}
export async function readRecoveryRecord(entry: RestoreEntry): Promise<RecoveryRecord> { if (!entry.name.startsWith('records/') || entry.size > 1000000)
    throw new AppError('INVALID_INPUT', 'Слишком большая запись резервной копии.'); const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await readFile(entry.file))); if (!value || typeof value !== 'object' || !['header', 'row', 'file'].includes(value.type))
    throw new AppError('INVALID_INPUT', 'Некорректная запись резервной копии.'); validateLogicalRecoveryRecord(value); return value; }
/** Private staging indexes are independent of the live installation database/fence. */
class RecoveryRows implements Iterable<RestoreEntry> {
    constructor(readonly path: string, readonly length: number) { }
    *[Symbol.iterator]() { let after = -1; while (true) {
        const db = new DatabaseSync(this.path, { readOnly: true });
        let page;
        try {
            page = db.prepare("select ordinal,name,size,sha256,file from entries where kind='record' and ordinal>? order by ordinal limit 64").all(after);
        }
        finally {
            db.close();
        }
        if (!page.length)
            return;
        for (const r of page) {
            after = Number(r.ordinal);
            yield r as unknown as RestoreEntry;
        }
    } }
    *entries(): Generator<[
        number,
        RestoreEntry
    ]> { let n = 0; for (const r of this)
        yield [n++, r]; }
}
export async function validateRecovery(entries: RestoreEntries, adapter: 'local' | 'managed') {
    const first = entries.at(0);
    if (!first)
        throw new AppError('INVALID_INPUT', 'Пустая копия.');
    const path = join(dirname(first.file), 'logical-index.sqlite'), db = new DatabaseSync(path);
    db.exec('pragma journal_mode=off;pragma synchronous=off;pragma cache_size=-4096;pragma temp_store=file;drop table if exists entries;drop table if exists paths;create table entries(name text primary key,kind text,ordinal integer,size integer,sha256 text,file text,used integer default 0);create index entry_order on entries(kind,ordinal);create table paths(key text primary key,path text,leaf integer);begin');
    let count = 0, bytes = 0, payloadCount = 0;
    try {
        const insert = db.prepare('insert into entries(name,kind,ordinal,size,sha256,file) values(?,?,?,?,?,?)');
        for (const e of entries) {
            const record = e.name.startsWith('records/');
            if (record) {
                count++;
                bytes += e.size;
                if (e.size > 1000000 || count > 1000000 || bytes > 768 * 1024 ** 2)
                    throw new AppError('INVALID_INPUT', 'Метаданные превышают проверенную ёмкость копии.');
            }
            else
                payloadCount++;
            insert.run(e.name, record ? 'record' : 'payload', Number(e.name.split('/')[1]!.split('.')[0]), e.size, e.sha256, e.file);
        }
        if (!count)
            throw new AppError('INVALID_INPUT', 'Нет метаданных.');
        const rows = new RecoveryRows(path, count);
        db.exec('commit');
        const headerEntry = db.prepare("select name,size,sha256,file from entries where kind='record' and ordinal=0").get() as unknown as RestoreEntry;
        if (!headerEntry)
            throw new AppError('INVALID_INPUT', 'Нет заголовка.');
        const header = await readRecoveryRecord(headerEntry);
        if (header.type !== 'header' || header.version !== 1 || header.schema !== 8 || header.adapter !== adapter)
            throw new AppError('INVALID_INPUT', 'Формат копии не соответствует целевой установке.');
        let ordinal = 0;
        const get = db.prepare("select name,size,sha256,file,used from entries where kind='payload' and name=?"), mark = db.prepare('update entries set used=1 where name=?'), lookup = db.prepare('select path,leaf from paths where key=?'), put = db.prepare('insert into paths values(?,?,?) on conflict(key) do update set leaf=max(paths.leaf,excluded.leaf)');
        for (const entry of rows) {
            if (entry.name !== 'records/' + ordinal++ + '.json')
                throw new AppError('INVALID_INPUT', 'Порядок метаданных повреждён.');
            if (entry === headerEntry || ordinal === 1)
                continue;
            const record = await readRecoveryRecord(entry);
            if (record.type === 'header')
                throw new AppError('INVALID_INPUT', 'Повторный заголовок.');
            if (record.type === 'row') {
                const tables: readonly string[] = adapter === 'local' ? localRecoveryTables : managedRecoveryTables;
                if (!tables.includes(record.table))
                    throw new AppError('INVALID_INPUT', 'Неизвестная таблица копии.');
                continue;
            }
            recoveryPath(record.path);
            const object = get.get(record.payload);
            if (!object || object.size !== record.size || object.sha256 !== record.sha256 || object.used || !['data', 'catalog', 'object'].includes(record.root))
                throw new AppError('INVALID_INPUT', 'Состав копии повреждён.');
            mark.run(record.payload);
            const parts = (record.root + '/' + record.path).split('/');
            for (let i = 1; i <= parts.length; i++) {
                const prefix = parts.slice(0, i).join('/'), key = prefix.toLowerCase(), old = lookup.get(key), leaf = i === parts.length ? 1 : 0;
                if (old && (old.path !== prefix || old.leaf === 1 || leaf === 1))
                    throw new AppError('INVALID_INPUT', 'Пути копии конфликтуют.');
                put.run(key, prefix, leaf);
            }
        }
        if (Number(db.prepare("select count(*) n from entries where kind='payload' and used=0").get()!.n))
            throw new AppError('INVALID_INPUT', 'Лишнее содержимое копии.');
        return { header, rows, payloads: { size: payloadCount, get(name: string) {
                    const read = new DatabaseSync(path, { readOnly: true });
                    try {
                        return read.prepare("select name,size,sha256,file from entries where kind='payload' and name=?").get(name) as RestoreEntry | undefined;
                    }
                    finally {
                        read.close();
                    }
                } } };
    }
    finally {
        db.close();
    }
}
