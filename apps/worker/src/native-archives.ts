import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, rename, rm, mkdtemp, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { AppError, type Principal, type SiteRepository, type RevisionRepository, type ArtifactStore } from '../../../packages/contracts/src/model.js';
import { object, string, uuid, integer } from '../../../packages/contracts/src/http.js';
import type { ExportHandle } from '../../../packages/contracts/src/recovery.js';
import { createBackup, exportSite } from '../../../packages/core/src/backup.js';
import type { BackupEntry, RestoreEntries } from '../../../packages/core/src/backup.js';
import { createSourceFiles } from '../../../packages/core/src/history.js';
import { checkArtifacts } from '../../../packages/core/src/artifacts.js';
import { LocalBackup } from '../../../packages/adapters/src/local-backup.js';
import type { LocalDatabase } from '../../../packages/adapters/src/local-database.js';
import { portableArchive, writeZip } from '../../../packages/adapters/src/backup-archive.js';
import { readRecoveryRecord, validateRecovery, recoveryPath, type RecoveryRecord } from '../../../packages/adapters/src/recovery-records.js';
import { privateDirectory, safeFile, readRegular, writeExclusive, missing } from '../../../packages/adapters/src/safe-files.js';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Remote = {
    origin: string;
    accessToken: string;
};
type Context = {
    actor: Principal;
    remote: Remote | null;
    sessionId: string;
};
type Inspection = {
    directory: string;
    entries: RestoreEntries;
    header: Extract<RecoveryRecord, {
        type: 'header';
    }>;
    users: {
        id: string;
        email: string | null;
    }[];
    mappings: {
        sourceId: string;
        destinationId: string;
    }[];
};
type Operation = {
    id: string;
    userId: string;
    sessionId: string;
    origin: string | null;
    expiresAt: number;
    state: 'working' | 'ready' | 'failed';
    result?: unknown;
    error?: string;
    file?: string;
    inspection?: Inspection;
};
export interface NativeArchiveDeps {
    native: boolean;
    root: string;
    baseRoot: string;
    sourceRoot: string;
    database: LocalDatabase;
    sites: SiteRepository;
    revisions: RevisionRepository;
    artifacts: ArtifactStore;
    quiesce<T>(action: () => Promise<T>): Promise<T>;
    close(): Promise<void>;
    fetch?: typeof fetch;
}
export class NativeArchives {
    private operations = new Map<string, Operation>();
    private localSession = randomUUID();
    private restored = false;
    constructor(readonly deps: NativeArchiveDeps) { }
    private directory() { return privateDirectory(join(this.deps.baseRoot, '.exports')); }
    private async call(remote: Remote, path: string, body?: unknown) {
        const method = body === undefined ? 'GET' : 'POST', deadline = method === 'POST' && path === '/admin/recovery/snapshots' ? 180000 : 30000;
        const response = await (this.deps.fetch ?? fetch)(remote.origin + path, { method, redirect: 'error', cache: 'no-store', headers: { authorization: 'Bearer ' + remote.accessToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(deadline) });
        const reader = response.body?.getReader(), parts: Uint8Array[] = [];
        let size = 0;
        if (reader)
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    size += part.value.length;
                    if (size > 64000)
                        throw new AppError('INVALID_INPUT', 'Ответ копии превышает лимит.');
                    parts.push(part.value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
                reader.releaseLock();
            }
        let value: any;
        try {
            value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(parts)));
        }
        catch {
            if (response.ok)
                throw new AppError('INVALID_INPUT', 'Ответ копии повреждён.');
        }
        if (!response.ok) {
            const error = value?.error, codes = ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'DUPLICATE_DOMAIN', 'CONFLICT', 'STALE_LEASE', 'UNAVAILABLE', 'PROVIDER_WAIT', 'NEEDS_ATTENTION'];
            if (value && typeof value === 'object' && Object.keys(value).every(k => k === 'error' || k === 'requestId') && typeof value.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(value.requestId) && error && typeof error === 'object' && Object.keys(error).length === 2 && codes.includes(error.code) && typeof error.message === 'string' && error.message.length > 0 && error.message.length <= 1000 && !/[\x00-\x1f]/.test(error.message))
                throw new AppError(error.code, error.message);
            throw new AppError(response.status === 403 ? 'FORBIDDEN' : response.status === 409 ? 'CONFLICT' : 'UNAVAILABLE', 'Операция копии отклонена сервером (' + response.status + ').');
        }
        return value;
    }
    private async context(value: unknown): Promise<Context> { if (value === undefined || value === null)
        return { actor: { userId: 'local-demo-admin', role: 'admin' }, remote: null, sessionId: this.localSession }; const p = object(value, ['origin', 'accessToken']), url = new URL(string(p.origin, 2048)), accessToken = string(p.accessToken, 8192); if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || /[\x00-\x1f]/.test(accessToken))
        throw new AppError('INVALID_INPUT', 'Неверное настроенное подключение.'); const remote = { origin: url.origin, accessToken }, session = await this.call(remote, '/session'); if (session?.principal?.role !== 'admin' || session?.capabilities?.admin !== true)
        throw new AppError('FORBIDDEN', 'Копии доступны администратору.'); let sessionId = digest(Buffer.from(accessToken)); try {
        const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
        if (typeof claims.session_id === 'string')
            sessionId = uuid(claims.session_id);
    }
    catch { } return { actor: { userId: uuid(session.principal.userId), role: 'admin' }, remote, sessionId }; }
    private operation(id: string, context: Context) { const op = this.operations.get(id); if (!op || op.expiresAt < Date.now() || op.userId !== context.actor.userId || op.sessionId !== context.sessionId || op.origin !== (context.remote?.origin ?? null))
        throw new AppError('NOT_FOUND', 'Операция копии истекла или относится к другой сессии.'); return op; }
    private start(context: Context, action: (op: Operation) => Promise<unknown>) { if (this.operations.size >= 4)
        throw new AppError('CONFLICT', 'Закройте готовые операции копирования перед новым запросом.'); const op: Operation = { id: randomUUID(), userId: context.actor.userId, sessionId: context.sessionId, origin: context.remote?.origin ?? null, expiresAt: Date.now() + 30 * 60000, state: 'working' }; this.operations.set(op.id, op); void Promise.resolve().then(() => action(op)).then(async (result) => { if (!this.operations.has(op.id)) {
        if (op.file)
            await rm(op.file, { force: true });
        if (op.inspection)
            await rm(op.inspection.directory, { recursive: true, force: true });
        return;
    } op.result = result; op.state = 'ready'; }, error => { op.error = error instanceof AppError ? error.message : 'Не удалось завершить копию. Исходная установка сохранена.'; op.state = 'failed'; }); return { id: op.id, state: op.state }; }
    private async handle(op: Operation, file: string, kind: ExportHandle['kind'], name?: string) { let size = 0; const hash = createHash('sha256'); for await (const part of createReadStream(file)) {
        size += part.length;
        hash.update(part);
    } op.file = file; return { handle: { id: op.id, kind, size, sha256: hash.digest('hex'), expiresAt: op.expiresAt, name: name ?? (kind === 'backup' ? 'site-factory-backup.sfbak' : kind === 'source' ? 'site-source.zip' : 'source-file.bin') } }; }
    private async chunked(remote: Remote, path: string, maximum: number) { const parts: Buffer[] = []; let offset = 0, total: number | null = null; do {
        const data = object(await this.call(remote, path + '&offset=' + offset), ['size', 'offset', 'base64', 'nextOffset', 'path', 'mediaType']);
        if (integer(data.offset) !== offset || typeof data.base64 !== 'string' || data.base64.length > 32000)
            throw new AppError('INVALID_INPUT', 'Неверная часть копии.');
        const size = integer(data.size, 0, maximum);
        if (total !== null && size !== total)
            throw new AppError('CONFLICT', 'Размер копии изменился.');
        total = size;
        const bytes = Buffer.from(data.base64, 'base64');
        if (bytes.length > 24000 || offset + bytes.length > size)
            throw new AppError('INVALID_INPUT', 'Содержимое копии превышено.');
        parts.push(bytes);
        offset += bytes.length;
        if (data.nextOffset === null) {
            if (offset !== size)
                throw new AppError('INVALID_INPUT', 'Содержимое усечено.');
            break;
        }
        if (integer(data.nextOffset) !== offset || bytes.length === 0)
            throw new AppError('INVALID_INPUT', 'Части копии не последовательны.');
    } while (offset <= maximum); return Buffer.concat(parts); }
    private async catalogFiles(pinned: string[]) { const root = this.deps.sourceRoot, styles = JSON.parse(new TextDecoder().decode(await readRegular(await safeFile(root, 'templates/catalog.json'), 200000))); if (!Array.isArray(styles))
        throw new AppError('INVALID_INPUT', 'Каталог шаблонов повреждён.'); for (const id of pinned)
        if (!styles.some(s => s.id + '@' + s.version === id))
            throw new AppError('NEEDS_ATTENTION', 'Закреплённая версия шаблона отсутствует на устройстве.'); const paths = ['templates/catalog.json', 'references/catalog.json']; for (const style of styles) {
        if (!Array.isArray(style.files))
            throw new AppError('INVALID_INPUT', 'Каталог шаблонов повреждён.');
        for (const file of style.files)
            paths.push('templates/' + style.id + '/' + file);
    } const result: {
        path: string;
        size: number;
        sha256: string;
        read: () => Promise<Uint8Array>;
    }[] = []; for (const path of paths) {
        recoveryPath(path);
        const bytes = await readRegular(await safeFile(root, path), 2000000);
        result.push({ path, size: bytes.length, sha256: digest(bytes), read: () => readRegular(join(root, path), 2000000) });
    } return { files: result, versions: styles.map(s => s.id + '@' + s.version) }; }
    private async managedBackup(op: Operation, context: Context, passphrase: string) {
        const remote = context.remote!, snapshot = await this.call(remote, '/admin/recovery/snapshots', {}), id = uuid(snapshot.id), count = integer(snapshot.records, 1, 1000000), directory = await this.directory(), self = this;
        try {
            async function* entries(): AsyncGenerator<BackupEntry> {
                for (let seq = 0; seq < count; seq++) {
                    const bytes = await self.chunked(remote, `/admin/recovery/snapshots/${id}/record?seq=${seq}`, 1000000), record = JSON.parse(bytes.toString('utf8')) as RecoveryRecord;
                    yield { name: 'records/' + seq + '.json', size: bytes.length, sha256: digest(bytes), read: async () => bytes };
                    if (record.type === 'file') {
                        const file = record;
                        yield { name: file.payload, size: file.size, sha256: file.sha256, read: () => self.chunked(remote, `/admin/recovery/snapshots/${id}/resource?seq=${seq}`, file.size) };
                    }
                    if (seq === 0) {
                        if (record.type !== 'header' || record.adapter !== 'managed')
                            throw new AppError('INVALID_INPUT', 'Неверный снимок.');
                        const needed = (record.pinnedCatalogs ?? []).filter(v => !(record.storedCatalogs ?? []).includes(v)), catalog = needed.length || !record.hasInstalledCatalog ? await self.catalogFiles(needed) : { files: [], versions: [] };
                        let extra = count;
                        if (!record.hasInstalledCatalog) {
                            const value = Buffer.from(JSON.stringify({ type: 'row', table: 'private.recovery_state', row: { key: 'installed-catalog', data: { versions: catalog.versions } } }));
                            yield { name: 'records/' + extra++ + '.json', size: value.length, sha256: digest(value), read: async () => value };
                        }
                        for (const file of catalog.files) {
                            if (extra >= 1000000)
                                throw new AppError('INVALID_INPUT', 'Опись каталога превышает ёмкость копии.');
                            const payload = 'payloads/' + extra + '.bin', metadata: RecoveryRecord = { type: 'file', root: 'catalog', path: file.path, payload, size: file.size, sha256: file.sha256, mediaType: 'application/octet-stream' }, encoded = Buffer.from(JSON.stringify(metadata));
                            yield { name: 'records/' + extra++ + '.json', size: encoded.length, sha256: digest(encoded), read: async () => encoded };
                            yield { name: payload, size: file.size, sha256: file.sha256, read: file.read };
                        }
                    }
                }
            }
            return { handle: await createBackup(context.actor, passphrase, { admin: async () => { await self.context(context.remote); }, snapshot: async () => ({ entries: entries(), release: async () => { } }), archive: portableArchive(directory), handle: async (file) => (await self.handle(op, file, 'backup')).handle, discard: file => rm(file, { force: true }) }) };
        }
        finally {
            await this.call(remote, `/admin/recovery/snapshots/${id}/close`, {}).catch(() => { });
        }
    }
    private async remoteSource(remote: Remote, siteId: string, revisionId: string) {
        const snapshot = await this.call(remote, `/sites/${siteId}/export`, { revisionId }), id = uuid(snapshot.id), count = integer(snapshot.records, 0, 100);
        try {
            const result = [];
            for (let seq = 0; seq < count; seq++) {
                const encoded = await this.chunked(remote, `/admin/recovery/snapshots/${id}/record?seq=${seq}`, 64000), record = JSON.parse(encoded.toString('utf8'));
                if (record.type !== 'file' || typeof record.sourcePath !== 'string')
                    throw new AppError('INVALID_INPUT', 'Неверная опись исходников.');
                const bytes = await this.chunked(remote, `/admin/recovery/snapshots/${id}/resource?seq=${seq}`, 2000000);
                if (bytes.length !== record.size || digest(bytes) !== record.sha256)
                    throw new AppError('INVALID_INPUT', 'Исходный файл повреждён.');
                result.push({ path: record.sourcePath, mediaType: record.mediaType, bytes });
            }
            checkArtifacts(result);
            return result;
        }
        finally {
            await this.call(remote, `/admin/recovery/snapshots/${id}/close`, {}).catch(() => { });
        }
    }
    private async source(context: Context, siteId: string, revisionId: string) { if (context.remote)
        return this.remoteSource(context.remote, siteId, revisionId); return createSourceFiles({ admin: async (actor) => { if (actor.role !== 'admin')
            throw new AppError('FORBIDDEN', 'Нет доступа.'); }, revision: async (s, r) => { const revision = await this.deps.revisions.get(r); return revision?.siteId === s ? revision : null; }, read: id => this.deps.artifacts.read(id) }).files(context.actor, siteId, revisionId); }
    async request(value: unknown): Promise<unknown> {
        if (!this.deps.native)
            throw new AppError('FORBIDDEN', 'Требуется отдельный нативный канал.');
        const p = object(value, ['action', 'remote', 'id', 'passphrase', 'siteId', 'revisionId', 'path', 'archivePath', 'destination', 'mappings']), action = string(p.action, 30), context = await this.context(p.remote);
        if (this.restored && !['status', 'save', 'close'].includes(action))
            throw new AppError('CONFLICT', 'Восстановленная установка выбрана; перезапустите приложение.');
        for (const [id, old] of this.operations)
            if (old.expiresAt < Date.now() || old.userId !== context.actor.userId || old.origin !== (context.remote?.origin ?? null) || old.sessionId !== context.sessionId) {
                this.operations.delete(id);
                if (old.file)
                    await rm(old.file, { force: true });
                if (old.inspection)
                    await rm(old.inspection.directory, { recursive: true, force: true });
            }
        if (action === 'backup') {
            const passphrase = string(p.passphrase, 1024);
            return this.start(context, op => context.remote ? this.managedBackup(op, context, passphrase) : new LocalBackup(this.deps.database, this.deps.sourceRoot, join(this.deps.baseRoot, '.exports'), capture => this.deps.quiesce(capture)).createBackup(context.actor, passphrase).then(file => this.handle(op, file, 'backup')));
        }
        if (action === 'source' || action === 'file') {
            const siteId = uuid(p.siteId), revisionId = uuid(p.revisionId), path = action === 'file' ? string(p.path, 240) : null;
            return this.start(context, async (op) => { if (!path && !context.remote) {
                const result = await exportSite(context.actor, siteId, revisionId, { source: { admin: async () => { await this.context(null); }, revision: async (s, r) => { const value = await this.deps.revisions.get(r); return value?.siteId === s ? value : null; }, read: id => this.deps.artifacts.read(id) }, write: async (files) => { const output = join(await this.directory(), randomUUID() + '.zip'); await writeZip(output, (async function* () { for (const f of files)
                        yield { name: f.path, size: f.bytes.length, sha256: digest(f.bytes), read: async () => f.bytes }; })()); return output; }, handle: async (file) => (await this.handle(op, file, 'source', 'site-source.zip')).handle, discard: file => rm(file, { force: true }) });
                return { handle: result };
            } const files = await this.source(context, siteId, revisionId), output = join(await this.directory(), randomUUID() + (path ? '.file' : '.zip')); if (path) {
                const file = files.find(f => f.path === path);
                if (!file)
                    throw new AppError('NOT_FOUND', 'Исходный файл не найден.');
                await writeExclusive(output, file.bytes);
            }
            else
                await writeZip(output, (async function* () { for (const f of files)
                    yield { name: f.path, size: f.bytes.length, sha256: digest(f.bytes), read: async () => f.bytes }; })()); return this.handle(op, output, path ? 'file' : 'source', path ? basename(path) : 'site-source.zip'); });
        }
        if (action === 'inspect') {
            const passphrase = string(p.passphrase, 1024), path = string(p.archivePath, 32768);
            return this.start(context, async (op) => { const verified = await portableArchive(await this.directory()).verify(path, passphrase); try {
                const parsed = await validateRecovery(verified.entries, context.remote ? 'managed' : 'local'), users = new Map<string, string | null>();
                for (const entry of parsed.rows) {
                    const r = await readRecoveryRecord(entry);
                    if (r.type === 'row' && r.table === 'public.users')
                        users.set(String(r.row.id), String(r.row.email));
                    if (r.type === 'row' && r.table === 'sites') {
                        const site = JSON.parse(String(r.row.data));
                        users.set(site.ownerId, null);
                    }
                }
                op.inspection = { ...verified, header: parsed.header, users: [...users].map(([id, email]) => ({ id, email })), mappings: [] };
                return { inspectionId: op.id, adapter: parsed.header.adapter, users: op.inspection.users };
            }
            catch (error) {
                await rm(verified.directory, { recursive: true, force: true });
                throw error;
            } });
        }
        const op = this.operation(uuid(p.id), context);
        if (action === 'status')
            return { id: op.id, state: op.state, ...(op.result === undefined ? {} : { result: op.result }), ...(op.error ? { error: op.error } : {}) };
        if (action === 'map') {
            if (!op.inspection || !Array.isArray(p.mappings) || p.mappings.length > 50)
                throw new AppError('INVALID_INPUT', 'Неверная порция привязок.');
            const merged = new Map(op.inspection.mappings.map(m => [m.sourceId, m]));
            for (const value of p.mappings) {
                const m = object(value, ['sourceId', 'destinationId']), sourceId = uuid(m.sourceId);
                merged.set(sourceId, { sourceId, destinationId: uuid(m.destinationId) });
            }
            if (merged.size > 5000)
                throw new AppError('INVALID_INPUT', 'Слишком много пользователей.');
            op.inspection.mappings = [...merged.values()];
            return { ok: true };
        }
        if (action === 'restore') {
            if ([...this.operations.values()].some(value => value.state === 'working'))
                throw new AppError('CONFLICT', 'Дождитесь завершения других операций копирования.');
            if (op.state !== 'ready' || !op.inspection)
                throw new AppError('CONFLICT', 'Сначала проверьте копию.');
            const inspection = op.inspection;
            if (!Array.isArray(p.mappings) || p.mappings.length > 5000)
                throw new AppError('INVALID_INPUT', 'Неверные привязки пользователей.');
            const mappings = p.mappings.map(v => { const m = object(v, ['sourceId', 'destinationId']); return { sourceId: uuid(m.sourceId), destinationId: uuid(m.destinationId) }; });
            return this.start(context, async (restore) => { if (context.remote) {
                const report = await this.managedRestore(context, inspection, mappings);
                delete op.inspection;
                await rm(inspection.directory, { recursive: true, force: true });
                return report;
            } const id = randomUUID(), parent = await privateDirectory(join(this.deps.baseRoot, '.restored')), target = join(parent, id), report = await new LocalBackup(this.deps.database, this.deps.sourceRoot, join(this.deps.baseRoot, '.exports')).restoreVerified(context.actor, inspection, target); await writeExclusive(join(this.deps.baseRoot, '.restore-status-' + id + '.json'), Buffer.from(JSON.stringify({ version: 1, id, state: 'staged', sourceId: inspection.header.sourceId, createdAt: Date.now() }))); await this.deps.close(); const temp = join(this.deps.baseRoot, '.active-root-' + id + '.json'); await writeExclusive(temp, Buffer.from(JSON.stringify({ version: 1, id }))); await rename(temp, join(this.deps.baseRoot, '.active-root.json')); this.restored = true; delete op.inspection; return { ...report, targetId: id, restartRequired: true }; });
        }
        if (action === 'save') {
            if (op.state !== 'ready' || !op.file)
                throw new AppError('CONFLICT', 'Файл ещё не готов.');
            const destination = string(p.destination, 32768), parent = await privateDirectory(dirname(destination), false), name = basename(destination);
            if (/[<>:"/\\|?*\x00-\x1f]/.test(name))
                throw new AppError('INVALID_INPUT', 'Неверное выбранное имя.');
            const final = await safeFile(parent, name), temp = join(parent, '.site-factory-save-' + randomUUID());
            try {
                await copyFile(op.file, temp);
                await rename(temp, final);
            }
            finally {
                await rm(temp, { force: true });
            }
            return { saved: true };
        }
        if (action === 'close') {
            this.operations.delete(op.id);
            if (op.file)
                await rm(op.file, { force: true });
            if (op.inspection)
                await rm(op.inspection.directory, { recursive: true, force: true });
            return { ok: true };
        }
        throw new AppError('INVALID_INPUT', 'Неизвестная операция копии.');
    }
    private async managedRestore(context: Context, inspection: Inspection, mappings: {
        sourceId: string;
        destinationId: string;
    }[]) {
        const remote = context.remote!, parsed = await validateRecovery(inspection.entries, 'managed'), merged = new Map(inspection.mappings.map(m => [m.sourceId, m]));
        for (const m of mappings)
            merged.set(m.sourceId, m);
        const all = [...merged.values()];
        if (all.length > 5000)
            throw new AppError('INVALID_INPUT', 'Слишком много пользователей.');
        const restore = await this.call(remote, '/admin/recovery/restores', { header: parsed.header, mappings: all.slice(0, 50), records: parsed.rows.length }), id = uuid(restore.id);
        try {
            for (let start = 50; start < all.length; start += 50)
                await this.call(remote, `/admin/recovery/restores/${id}/mappings`, { mappings: all.slice(start, start + 50) });
            for (const [seq, entry] of parsed.rows.entries()) {
                const bytes = Buffer.from(await readRegular(entry.file, 1000000));
                for (let offset = 0, index = 0; offset < bytes.length; offset += 24000, index++)
                    await this.call(remote, `/admin/recovery/restores/${id}/record-part`, { seq, index, base64: bytes.subarray(offset, offset + 24000).toString('base64') });
                await this.call(remote, `/admin/recovery/restores/${id}/record-complete`, { seq });
                const record = await readRecoveryRecord(entry);
                if (record.type === 'file') {
                    const file = parsed.payloads.get(record.payload)!;
                    const bytes = await readRegular(file.file, (32 * 1024 ** 2));
                    for (let offset = 0, index = 0; offset < bytes.length; offset += 24000, index++)
                        await this.call(remote, `/admin/recovery/restores/${id}/chunk`, { seq, index, base64: Buffer.from(bytes.subarray(offset, offset + 24000)).toString('base64') });
                    await this.call(remote, `/admin/recovery/restores/${id}/object-complete`, { seq });
                }
            }
            return await this.call(remote, `/admin/recovery/restores/${id}/install`, {});
        }
        catch (error) {
            throw new AppError('CONFLICT', 'Восстановление не установлено. Подготовленный сеанс ' + id + ' сохранён для сверки. ' + (error instanceof AppError ? error.message : ''));
        }
    }
}
