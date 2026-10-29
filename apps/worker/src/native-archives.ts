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
import { RemoteRecoveryTransfer } from './remote-recovery-transfer.js';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Remote = {
    origin: string;
    accessToken: string;
    sessionScope?: string;
};
type Context = {
    actor: Principal;
    remote: Remote | null;
    sessionId: string;
};
type Inspection = {
    resume?: {
        id?: string;
    };
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
    createdAt: number;
    lastPoll: number;
    verifiedAt: number;
    remote: Remote | null;
    abort: AbortController;
    work?: Promise<void>;
    renewal?: Promise<unknown>;
    inFinalCommit?: boolean;
    transferId?: string;
    snapshotId?: string;
    lastActivity?: number;
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
    private stopping = false;
    private switchOwner: Operation | null = null;
    private inFlight = 0;
    private requests = new Set<Promise<unknown>>();
    private draining: Promise<void> | undefined;
    private remoteSignals = new WeakMap<Remote, AbortSignal>();
    private networkWaiters: (() => void)[] = [];
    private async call(remote: Remote, path: string, body?: unknown, signal?: AbortSignal) {
        if (this.inFlight >= 4)
            await new Promise<void>(resolve => {
                if (this.networkWaiters.length >= 64)
                    throw new AppError('CONFLICT', 'Слишком много запросов копии.');
                this.networkWaiters.push(resolve);
            });
        else
            this.inFlight++;
        try {
            return await this.send(remote, path, body, signal ?? this.remoteSignals.get(remote));
        }
        finally {
            const next = this.networkWaiters.shift();
            if (next)
                next();
            else
                this.inFlight--;
        }
    }
    private async cancel(op: Operation) {
        op.abort.abort();
        await op.work?.catch(() => { });
        this.operations.delete(op.id);
        if (op.file)
            await rm(op.file, {
                force: true
            });
        if (op.inspection)
            await rm(op.inspection.directory, {
                recursive: true, force: true
            });
        if (op.remote && op.transferId)
            await this.call({
                ...op.remote
            }, `/admin/recovery/restores/${op.transferId}/cancel`, {}).catch(() => { });
    }
    shutdown(): Promise<void> {
        if (this.draining)
            return this.draining;
        this.stopping = true;
        return this.draining = (async () => { await Promise.allSettled([...this.operations.values()].filter(op => op !== this.switchOwner).map(op => this.cancel(op))); await Promise.allSettled([...this.requests]); })();
    }
    private transfer(op: Operation, directory: string) { return new RemoteRecoveryTransfer((path, body) => this.operationCall(op, path, body), directory, op.abort.signal); }
    private async operationCall(op: Operation, path: string, body?: unknown) {
        const guard = () => { if (op.abort.signal.aborted || Date.now() > op.expiresAt || Date.now() > op.createdAt + 24 * 3600000 || Date.now() - op.lastPoll > 60000) {
            op.abort.abort();
            throw new AppError('UNAUTHENTICATED', 'Операция остановлена: обновите вход и повторите подготовку.');
        } };
        guard();
        const commit = body !== undefined && /^\/admin\/recovery\/restores\/[a-f0-9-]{36}\/commit$/.test(path);
        if (commit)
            op.inFinalCommit = true;
        try {
            // Suppress first, then drain any already-admitted renewal before the exclusive action.
            if (commit)
                await op.renewal;
            guard();
            const value = await this.call(op.remote!, path, body, op.abort.signal);
            if (path.includes('/batch') || path.endsWith('/prepare') || path.endsWith('/renew'))
                op.expiresAt = Math.min(op.createdAt + 24 * 3600000, typeof value?.expiresAt === 'number' ? value.expiresAt : Date.now() + 30 * 60000);
            op.lastActivity = Date.now();
            return value;
        }
        finally {
            if (commit)
                op.inFinalCommit = false;
        }
    }
    constructor(readonly deps: NativeArchiveDeps) { }
    private directory() { return privateDirectory(join(this.deps.baseRoot, '.exports')); }
    private async send(remote: Remote, path: string, body?: unknown, signal?: AbortSignal) {
        const method = body === undefined ? 'GET' : 'POST', batch = /^\/admin\/recovery\/(snapshots|restores)\/[a-f0-9-]{36}\/batch(?:\?|$)/.test(path), maximum = batch ? 2 * 1024 ** 2 : 64000, deadline = method === 'POST' && (path === '/admin/recovery/snapshots' || /^\/admin\/recovery\/restores\/[a-f0-9-]{36}\/commit$/.test(path)) ? 180000 : 30000;
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        if (encoded && Buffer.byteLength(encoded) > maximum)
            throw new AppError('INVALID_INPUT', 'Запрос копии превышает лимит.');
        const response = await (this.deps.fetch ?? fetch)(remote.origin + path, {
            method, redirect: 'error', cache: 'no-store', headers: {
                authorization: 'Bearer ' + remote.accessToken, ...(body === undefined ? {} : {
                    'content-type': 'application/json'
                })
            }, ...(body === undefined ? {} : {
                body: encoded!
            }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(deadline)]) : AbortSignal.timeout(deadline)
        });
        const reader = response.body?.getReader(), parts: Uint8Array[] = [];
        let size = 0;
        if (reader)
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    size += part.value.length;
                    if (size > maximum)
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
            value = JSON.parse(new TextDecoder('utf8', {
                fatal: true
            }).decode(Buffer.concat(parts)));
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
        if (path === '/session') {
            const scope = response.headers.get('x-site-factory-session');
            if (scope && /^[a-f0-9]{64}$/.test(scope))
                remote.sessionScope = scope;
        }
        return value;
    }
    private async context(value: unknown): Promise<Context> {
        if (value === undefined || value === null)
            return {
                actor: {
                    userId: 'local-demo-admin', role: 'admin'
                }, remote: null, sessionId: this.localSession
            };
        const p = object(value, ['origin', 'accessToken']), url = new URL(string(p.origin, 2048)), accessToken = string(p.accessToken, 8192);
        if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || /[\x00-\x1f]/.test(accessToken))
            throw new AppError('INVALID_INPUT', 'Неверное настроенное подключение.');
        const remote: Remote = {
            origin: url.origin, accessToken
        }, session = await this.call(remote, '/session');
        if (session?.principal?.role !== 'admin' || session?.capabilities?.admin !== true)
            throw new AppError('FORBIDDEN', 'Копии доступны администратору.');
        const sessionId = remote.sessionScope ?? digest(Buffer.from(accessToken));
        return {
            actor: {
                userId: uuid(session.principal.userId), role: 'admin'
            }, remote, sessionId
        };
    }
    private operation(id: string, context: Context) {
        const op = this.operations.get(id);
        if (!op || op.expiresAt < Date.now() || op.userId !== context.actor.userId || op.sessionId !== context.sessionId || op.origin !== (context.remote?.origin ?? null))
            throw new AppError('NOT_FOUND', 'Операция копии истекла или относится к другой сессии.');
        return op;
    }
    private start(context: Context, action: (op: Operation) => Promise<unknown>) {
        if (this.stopping || this.operations.size >= 4)
            throw new AppError('CONFLICT', 'Закройте готовые операции копирования перед новым запросом.');
        const now = Date.now(), op: Operation = {
            id: randomUUID(), userId: context.actor.userId, sessionId: context.sessionId, origin: context.remote?.origin ?? null, remote: context.remote, createdAt: now, lastPoll: now, verifiedAt: now, expiresAt: now + 30 * 60000, state: 'working', abort: new AbortController()
        };
        this.operations.set(op.id, op);
        if (context.remote)
            this.remoteSignals.set(context.remote, op.abort.signal);
        const timer = setInterval(() => {
            if (op.state !== 'working' || !op.remote)
                return;
            if (Date.now() - op.lastPoll > 60000 || Date.now() - op.verifiedAt > 60000) {
                op.abort.abort();
                return;
            }
            if (op.renewal || op.inFinalCommit)
                return;
            const id = op.transferId ?? op.snapshotId;
            if (!id || Date.now() - (op.lastActivity ?? op.createdAt) < 30000)
                return;
            op.renewal = this.operationCall(op, '/admin/recovery/' + (op.transferId ? 'restores/' : 'snapshots/') + id + '/renew', {}).catch(() => { op.abort.abort(); }).finally(() => { delete op.renewal; });
        }, 30000);
        op.work = Promise.resolve().then(() => action(op)).then(result => {
            if (op.abort.signal.aborted) {
                op.error = 'Операция остановлена. Обновите вход и повторите подготовку.';
                op.state = 'failed';
                return;
            }
            op.result = result;
            op.state = 'ready';
            op.expiresAt = Date.now() + 30 * 60000;
        }, error => { op.error = error instanceof AppError ? error.message : 'Не удалось завершить копию. Исходная установка сохранена.'; op.state = 'failed'; }).finally(async () => { clearInterval(timer); await op.renewal; });
        return {
            id: op.id, state: op.state
        };
    }
    private async handle(op: Operation, file: string, kind: ExportHandle['kind'], name?: string) {
        op.file = file;
        let size = 0;
        const hash = createHash('sha256');
        for await (const part of createReadStream(file)) {
            size += part.length;
            hash.update(part);
        }
        op.abort.signal.throwIfAborted();
        if (Date.now() > op.createdAt + 24 * 3600000)
            throw new AppError('NOT_FOUND', 'Операция копии истекла.');
        op.expiresAt = Date.now() + 30 * 60000;
        op.file = file;
        return {
            handle: {
                id: op.id, kind, size, sha256: hash.digest('hex'), expiresAt: op.expiresAt, name: name ?? (kind === 'backup' ? 'site-factory-backup.sfbak' : kind === 'source' ? 'site-source.zip' : 'source-file.bin')
            }
        };
    }
    private async chunked(remote: Remote, path: string, maximum: number) {
        const parts: Buffer[] = [];
        let offset = 0, total: number | null = null;
        do {
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
        } while (offset <= maximum);
        return Buffer.concat(parts);
    }
    private async catalogFiles(pinned: string[]) {
        const root = this.deps.sourceRoot, styles = JSON.parse(new TextDecoder().decode(await readRegular(await safeFile(root, 'templates/catalog.json'), 200000)));
        if (!Array.isArray(styles))
            throw new AppError('INVALID_INPUT', 'Каталог шаблонов повреждён.');
        for (const id of pinned)
            if (!styles.some(s => s.id + '@' + s.version === id))
                throw new AppError('NEEDS_ATTENTION', 'Закреплённая версия шаблона отсутствует на устройстве.');
        const paths = ['templates/catalog.json', 'references/catalog.json'];
        for (const style of styles) {
            if (!Array.isArray(style.files))
                throw new AppError('INVALID_INPUT', 'Каталог шаблонов повреждён.');
            for (const file of style.files)
                paths.push('templates/' + style.id + '/' + file);
        }
        const result: {
            path: string;
            size: number;
            sha256: string;
            read: () => Promise<Uint8Array>;
        }[] = [];
        for (const path of paths) {
            recoveryPath(path);
            const bytes = await readRegular(await safeFile(root, path), 2000000);
            result.push({
                path, size: bytes.length, sha256: digest(bytes), read: () => readRegular(join(root, path), 2000000)
            });
        }
        return {
            files: result, versions: styles.map(s => s.id + '@' + s.version)
        };
    }
    private async managedBackup(op: Operation, context: Context, passphrase: string) {
        const remote = context.remote!, snapshot = await this.call(remote, '/admin/recovery/snapshots', {}), id = uuid(snapshot.id), count = integer(snapshot.records, 1, 1000000), directory = await this.directory(), spool = await mkdtemp(join(directory, 'transfer-')), self = this, transfer = this.transfer(op, spool);
        op.snapshotId = id;
        try {
            async function* entries(): AsyncGenerator<BackupEntry> {
                for await (const { seq, bytes, record, read } of transfer.records(id, count)) {
                    yield {
                        name: 'records/' + seq + '.json', size: bytes.length, sha256: digest(bytes), read: async () => bytes
                    };
                    if (record.type === 'file') {
                        const file = record;
                        yield {
                            name: file.payload, size: file.size, sha256: file.sha256, read
                        };
                    }
                    if (seq === 0) {
                        if (record.type !== 'header' || record.adapter !== 'managed')
                            throw new AppError('INVALID_INPUT', 'Неверный снимок.');
                        const needed = (record.pinnedCatalogs ?? []).filter(v => !(record.storedCatalogs ?? []).includes(v)), catalog = needed.length || !record.hasInstalledCatalog ? await self.catalogFiles(needed) : {
                            files: [], versions: []
                        };
                        let extra = count;
                        if (!record.hasInstalledCatalog) {
                            const value = Buffer.from(JSON.stringify({
                                type: 'row', table: 'private.recovery_state', row: {
                                    key: 'installed-catalog', data: {
                                        versions: catalog.versions
                                    }
                                }
                            }));
                            yield {
                                name: 'records/' + extra++ + '.json', size: value.length, sha256: digest(value), read: async () => value
                            };
                        }
                        for (const file of catalog.files) {
                            if (extra >= 1000000)
                                throw new AppError('INVALID_INPUT', 'Опись каталога превышает ёмкость копии.');
                            const payload = 'payloads/' + extra + '.bin', metadata: RecoveryRecord = {
                                type: 'file', root: 'catalog', path: file.path, payload, size: file.size, sha256: file.sha256, mediaType: 'application/octet-stream'
                            }, encoded = Buffer.from(JSON.stringify(metadata));
                            yield {
                                name: 'records/' + extra++ + '.json', size: encoded.length, sha256: digest(encoded), read: async () => encoded
                            };
                            yield {
                                name: payload, size: file.size, sha256: file.sha256, read: file.read
                            };
                        }
                    }
                }
            }
            return {
                handle: await createBackup(context.actor, passphrase, {
                    admin: async () => {
                        await self.context(op.remote ? {
                            origin: op.remote.origin, accessToken: op.remote.accessToken
                        } : null);
                    }, snapshot: async () => ({
                        entries: entries(), release: async () => { }
                    }), archive: portableArchive(directory), handle: async (file) => (await self.handle(op, file, 'backup')).handle, discard: file => rm(file, {
                        force: true
                    })
                })
            };
        }
        finally {
            await this.call({
                ...op.remote!
            }, `/admin/recovery/snapshots/${id}/cancel`, {}).catch(() => { });
            delete op.snapshotId;
            await rm(spool, {
                recursive: true, force: true
            });
        }
    }
    private async remoteSource(remote: Remote, siteId: string, revisionId: string) {
        const snapshot = await this.call(remote, `/sites/${siteId}/export`, {
            revisionId
        }), id = uuid(snapshot.id), count = integer(snapshot.records, 0, 100);
        try {
            const result = [];
            for (let seq = 0; seq < count; seq++) {
                const encoded = await this.chunked(remote, `/admin/recovery/snapshots/${id}/record?seq=${seq}`, 64000), record = JSON.parse(encoded.toString('utf8'));
                if (record.type !== 'file' || typeof record.sourcePath !== 'string')
                    throw new AppError('INVALID_INPUT', 'Неверная опись исходников.');
                const bytes = await this.chunked(remote, `/admin/recovery/snapshots/${id}/resource?seq=${seq}`, 2000000);
                if (bytes.length !== record.size || digest(bytes) !== record.sha256)
                    throw new AppError('INVALID_INPUT', 'Исходный файл повреждён.');
                result.push({
                    path: record.sourcePath, mediaType: record.mediaType, bytes
                });
            }
            checkArtifacts(result);
            return result;
        }
        finally {
            await this.call(remote, `/admin/recovery/snapshots/${id}/close`, {}).catch(() => { });
        }
    }
    private async source(context: Context, siteId: string, revisionId: string) {
        if (context.remote)
            return this.remoteSource(context.remote, siteId, revisionId);
        return createSourceFiles({
            admin: async (actor) => {
                if (actor.role !== 'admin')
                    throw new AppError('FORBIDDEN', 'Нет доступа.');
            }, revision: async (s, r) => { const revision = await this.deps.revisions.get(r); return revision?.siteId === s ? revision : null; }, read: id => this.deps.artifacts.read(id)
        }).files(context.actor, siteId, revisionId);
    }
    request(value: unknown): Promise<unknown> { const work = this.dispatch(value); this.requests.add(work); void work.then(() => this.requests.delete(work), () => this.requests.delete(work)); return work; }
    private async dispatch(value: unknown): Promise<unknown> {
        if (!this.deps.native)
            throw new AppError('FORBIDDEN', 'Требуется отдельный нативный канал.');
        const p = object(value, ['action', 'remote', 'id', 'passphrase', 'siteId', 'revisionId', 'path', 'archivePath', 'destination', 'mappings']), action = string(p.action, 30);
        const pending = typeof p.id === 'string' ? this.operations.get(p.id) : undefined;
        if (pending && (pending.expiresAt < Date.now() || pending.state === 'working' && pending.createdAt + 24 * 3600000 < Date.now())) {
            await this.cancel(pending);
            throw new AppError('NOT_FOUND', 'Операция копии истекла.');
        }
        if (this.stopping && !this.restored && !(action === 'status' && pending === this.switchOwner))
            throw new AppError('CONFLICT', 'Исполнитель закрывается; повторите после перезапуска.');
        const supplied = p.remote as Remote | undefined;
        if (action === 'close' && pending && ((!pending.remote && !supplied) || (pending.remote && supplied?.origin === pending.origin && supplied.accessToken === pending.remote.accessToken))) {
            await this.cancel(pending);
            return {
                ok: true
            };
        }
        if (action === 'status' && pending?.state === 'working' && Date.now() - pending.verifiedAt < 30000 && supplied?.accessToken === pending.remote?.accessToken && ((supplied?.origin ?? null) === pending.origin)) {
            pending.lastPoll = Date.now();
            return {
                id: pending.id, state: 'working'
            };
        }
        let context: Context;
        try {
            context = await this.context(p.remote);
        }
        catch (error) {
            if (pending)
                await this.cancel(pending);
            throw error;
        }
        if (pending && (pending.sessionId !== context.sessionId || pending.userId !== context.actor.userId || pending.origin !== (context.remote?.origin ?? null))) {
            await this.cancel(pending);
            throw new AppError('UNAUTHENTICATED', 'Вход или установка изменились. Повторите подготовку после входа; прежний сеанс не продлевается.');
        }
        if (pending && pending.sessionId === context.sessionId && pending.userId === context.actor.userId && pending.origin === (context.remote?.origin ?? null)) {
            pending.remote = context.remote;
            pending.verifiedAt = Date.now();
            pending.lastPoll = Date.now();
            if (pending.state === 'working')
                pending.expiresAt = Math.min(pending.createdAt + 24 * 3600000, Date.now() + 30 * 60000);
        }
        if (this.restored && !['status', 'save', 'close'].includes(action))
            throw new AppError('CONFLICT', 'Восстановленная установка выбрана; перезапустите приложение.');
        for (const [id, old] of this.operations)
            if (old.expiresAt < Date.now() || old.userId !== context.actor.userId || old.origin !== (context.remote?.origin ?? null) || old.sessionId !== context.sessionId) {
                await this.cancel(old);
            }
        if (action === 'backup') {
            const passphrase = string(p.passphrase, 1024);
            return this.start(context, op => context.remote ? this.managedBackup(op, context, passphrase) : new LocalBackup(this.deps.database, this.deps.sourceRoot, join(this.deps.baseRoot, '.exports'), capture => this.deps.quiesce(capture)).createBackup(context.actor, passphrase, op.abort.signal).then(file => this.handle(op, file, 'backup')));
        }
        if (action === 'source' || action === 'file') {
            const siteId = uuid(p.siteId), revisionId = uuid(p.revisionId), path = action === 'file' ? string(p.path, 240) : null;
            return this.start(context, async (op) => {
                if (!path && !context.remote) {
                    const result = await exportSite(context.actor, siteId, revisionId, {
                        source: {
                            admin: async () => { await this.context(null); }, revision: async (s, r) => { const value = await this.deps.revisions.get(r); return value?.siteId === s ? value : null; }, read: id => this.deps.artifacts.read(id)
                        }, write: async (files) => {
                            const output = join(await this.directory(), randomUUID() + '.zip');
                            await writeZip(output, (async function* () {
                                for (const f of files)
                                    yield {
                                        name: f.path, size: f.bytes.length, sha256: digest(f.bytes), read: async () => f.bytes
                                    };
                            })());
                            return output;
                        }, handle: async (file) => (await this.handle(op, file, 'source', 'site-source.zip')).handle, discard: file => rm(file, {
                            force: true
                        })
                    });
                    return {
                        handle: result
                    };
                }
                const files = await this.source(context, siteId, revisionId), output = join(await this.directory(), randomUUID() + (path ? '.file' : '.zip'));
                if (path) {
                    const file = files.find(f => f.path === path);
                    if (!file)
                        throw new AppError('NOT_FOUND', 'Исходный файл не найден.');
                    await writeExclusive(output, file.bytes);
                }
                else
                    await writeZip(output, (async function* () {
                        for (const f of files)
                            yield {
                                name: f.path, size: f.bytes.length, sha256: digest(f.bytes), read: async () => f.bytes
                            };
                    })());
                return this.handle(op, output, path ? 'file' : 'source', path ? basename(path) : 'site-source.zip');
            });
        }
        if (action === 'inspect') {
            const passphrase = string(p.passphrase, 1024), path = string(p.archivePath, 32768);
            return this.start(context, async (op) => {
                const verified = await portableArchive(await this.directory()).verify(path, passphrase);
                try {
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
                    op.inspection = {
                        ...verified, header: parsed.header, users: [...users].map(([id, email]) => ({
                            id, email
                        })), mappings: []
                    };
                    return {
                        inspectionId: op.id, adapter: parsed.header.adapter, users: op.inspection.users
                    };
                }
                catch (error) {
                    await rm(verified.directory, {
                        recursive: true, force: true
                    });
                    throw error;
                }
            });
        }
        const op = this.operation(uuid(p.id), context);
        if (action === 'status')
            return {
                id: op.id, state: op.state, ...(op.result === undefined ? {} : {
                    result: op.result
                }), ...(op.error ? {
                    error: op.error
                } : {})
            };
        if (action === 'map') {
            if (!op.inspection || !Array.isArray(p.mappings) || p.mappings.length > 50)
                throw new AppError('INVALID_INPUT', 'Неверная порция привязок.');
            const merged = new Map(op.inspection.mappings.map(m => [m.sourceId, m]));
            for (const value of p.mappings) {
                const m = object(value, ['sourceId', 'destinationId']), sourceId = uuid(m.sourceId);
                merged.set(sourceId, {
                    sourceId, destinationId: uuid(m.destinationId)
                });
            }
            if (merged.size > 5000)
                throw new AppError('INVALID_INPUT', 'Слишком много пользователей.');
            op.inspection.mappings = [...merged.values()];
            return {
                ok: true
            };
        }
        if (action === 'restore') {
            if ([...this.operations.values()].some(value => value.state === 'working'))
                throw new AppError('CONFLICT', 'Дождитесь завершения других операций копирования.');
            if (op.state !== 'ready' || !op.inspection)
                throw new AppError('CONFLICT', 'Сначала проверьте копию.');
            const inspection = op.inspection;
            if (!Array.isArray(p.mappings) || p.mappings.length > 5000)
                throw new AppError('INVALID_INPUT', 'Неверные привязки пользователей.');
            const mappings = p.mappings.map(v => {
                const m = object(v, ['sourceId', 'destinationId']);
                return {
                    sourceId: uuid(m.sourceId), destinationId: uuid(m.destinationId)
                };
            });
            return this.start(context, async (restore) => {
                if (context.remote) {
                    const report = await this.managedRestore(restore, context, inspection, mappings);
                    delete op.inspection;
                    await rm(inspection.directory, {
                        recursive: true, force: true
                    });
                    return report;
                }
                const id = randomUUID(), parent = await privateDirectory(join(this.deps.baseRoot, '.restored')), target = join(parent, id), report = await new LocalBackup(this.deps.database, this.deps.sourceRoot, join(this.deps.baseRoot, '.exports')).restoreVerified(context.actor, inspection, target);
                await writeExclusive(join(this.deps.baseRoot, '.restore-status-' + id + '.json'), Buffer.from(JSON.stringify({
                    version: 1, id, state: 'staged', sourceId: inspection.header.sourceId, createdAt: Date.now()
                })));
                restore.abort.signal.throwIfAborted();
                this.switchOwner = restore;
                await this.deps.close();
                const temp = join(this.deps.baseRoot, '.active-root-' + id + '.json');
                await writeExclusive(temp, Buffer.from(JSON.stringify({
                    version: 1, id
                })));
                await rename(temp, join(this.deps.baseRoot, '.active-root.json'));
                this.restored = true;
                delete op.inspection;
                return {
                    ...report, targetId: id, restartRequired: true
                };
            });
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
                await rm(temp, {
                    force: true
                });
            }
            return {
                saved: true
            };
        }
        if (action === 'close') {
            this.operations.delete(op.id);
            if (op.file)
                await rm(op.file, {
                    force: true
                });
            if (op.inspection)
                await rm(op.inspection.directory, {
                    recursive: true, force: true
                });
            return {
                ok: true
            };
        }
        throw new AppError('INVALID_INPUT', 'Неизвестная операция копии.');
    }
    private async managedRestore(op: Operation, context: Context, inspection: Inspection, mappings: {
        sourceId: string;
        destinationId: string;
    }[]) {
        const parsed = await validateRecovery(inspection.entries, 'managed'), merged = new Map(inspection.mappings.map(m => [m.sourceId, m]));
        for (const m of mappings)
            merged.set(m.sourceId, m);
        const all = [...merged.values()];
        if (all.length > 5000)
            throw new AppError('INVALID_INPUT', 'Слишком много пользователей.');
        const spool = await mkdtemp(join(await this.directory(), 'transfer-'));
        try {
            return await new RemoteRecoveryTransfer((path, body) => this.operationCall(op, path, body), spool, op.abort.signal).restore(parsed, all, inspection.resume ?? (inspection.resume = {}), id => { op.transferId = id; });
        }
        catch (error) {
            throw new AppError(error instanceof AppError ? error.code : 'CONFLICT', 'Восстановление не установлено. Подготовленный сеанс ' + (op.transferId ?? '') + ' сохранён для сверки. ' + (error instanceof AppError ? error.message : ''));
        }
        finally {
            await rm(spool, {
                recursive: true, force: true
            });
        }
    }
}
