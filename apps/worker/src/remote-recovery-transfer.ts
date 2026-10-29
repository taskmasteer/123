import { createHash } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../../packages/contracts/src/model.js';
import { batchContent, transferBinding, transferCursor, transferLimits, transferPage, transferProgress, type RecoveryTransferBinding, type RecoveryTransferBatch, type RecoveryTransferPart } from '../../../packages/contracts/src/recovery-transfer.js';
import { readRecoveryRecord, type validateRecovery, type RecoveryRecord } from '../../../packages/adapters/src/recovery-records.js';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Call = (path: string, body?: unknown) => Promise<any>;
export interface RecoveryRestoreStream {
    header: Extract<RecoveryRecord, {
        type: 'header';
    }>;
    records: number;
    inventoryDigest: string;
    metadata(): AsyncIterable<{
        seq: number;
        bytes: Uint8Array;
    }>;
    resources(): AsyncIterable<{
        seq: number;
        record: Extract<RecoveryRecord, {
            type: 'file';
        }>;
        read(offset: number, length: number): Promise<Uint8Array>;
    }>;
}
const bad = (): never => { throw new AppError('INVALID_INPUT', 'Пакеты копии повреждены или относятся к другому источнику.'); };
/** Node↔control framing only. Neither renderer nor Rust sees these batches. */
export class RemoteRecoveryTransfer {
    private files = new Map<number, {
        path: string;
        offset: number;
        complete: boolean;
        size: number;
        sha256: string;
        bytes?: Buffer;
    }>();
    private resourceCursor: string | null = null;
    private binding?: RecoveryTransferBinding;
    constructor(readonly call: Call, readonly directory: string, readonly signal: AbortSignal, readonly delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) { }
    private async request(path: string, body?: unknown) {
        for (let attempt = 0;; attempt++) {
            this.signal.throwIfAborted();
            try {
                return await this.call(path, body);
            }
            catch (error) {
                if (this.signal.aborted || attempt === 3 || error instanceof AppError && error.code !== 'UNAVAILABLE')
                    throw error;
                await this.delay([100, 500, 1500][attempt]!);
            }
        }
    }
    private page(value: unknown) {
        const page = transferPage(value);
        if (sha(batchContent(page)) !== page.digest)
            return bad();
        if (this.binding && JSON.stringify(this.binding) !== JSON.stringify(page.binding))
            return bad();
        this.binding = page.binding;
        return page;
    }
    async *records(id: string, count: number): AsyncGenerator<{
        seq: number;
        bytes: Buffer;
        record: RecoveryRecord;
        read: () => Promise<Uint8Array>;
    }> {
        let cursor: string | null = 'start', expected = 0, pending: Buffer[] = [], offset = 0;
        while (cursor) {
            const page = this.page(await this.request(`/admin/recovery/snapshots/${id}/batch?cursor=${encodeURIComponent(cursor)}`));
            if (page.kind !== 'metadata' || page.cursor !== cursor || page.binding.id !== id || page.binding.records !== count)
                return bad();
            this.resourceCursor = page.resourceCursor;
            for (const part of page.items) {
                if (part.seq !== expected || part.offset !== offset)
                    return bad();
                const bytes = Buffer.from(part.base64, 'base64');
                pending.push(bytes);
                offset += bytes.length;
                if (part.complete) {
                    const full = Buffer.concat(pending);
                    if (offset !== part.size || sha(full) !== part.sha256)
                        return bad();
                    let record: RecoveryRecord;
                    try {
                        record = JSON.parse(new TextDecoder('utf8', {
                            fatal: true
                        }).decode(full));
                    }
                    catch {
                        return bad();
                    }
                    const seq = expected++;
                    pending = [];
                    offset = 0;
                    yield {
                        seq, bytes: full, record, read: () => this.resource(id, seq, record)
                    };
                }
            }
            if (page.nextCursor === cursor)
                return bad();
            cursor = page.nextCursor;
        }
        if (expected !== count || pending.length)
            return bad();
    }
    private async resource(id: string, seq: number, record: RecoveryRecord) {
        if (record.type !== 'file')
            return bad();
        while (!this.files.get(seq)?.complete) {
            if (!this.resourceCursor)
                return bad();
            const cursor = this.resourceCursor, page = this.page(await this.request(`/admin/recovery/snapshots/${id}/batch?cursor=${encodeURIComponent(cursor)}`));
            if (page.kind !== 'resources' || page.cursor !== cursor || page.nextCursor === cursor)
                return bad();
            for (const part of page.items) {
                let file = this.files.get(part.seq);
                if (!file) {
                    if (part.offset !== 0 || this.files.size >= 64)
                        return bad();
                    file = {
                        path: join(this.directory, 'resource-' + part.seq), offset: 0, complete: false, size: part.size, sha256: part.sha256
                    };
                    this.files.set(part.seq, file);
                }
                if (file.offset !== part.offset || file.size !== part.size || file.sha256 !== part.sha256)
                    return bad();
                const bytes = Buffer.from(part.base64, 'base64');
                if (part.complete && file.offset === 0)
                    file.bytes = bytes;
                else {
                    const handle = await open(file.path, file.offset ? 'a' : 'wx', 0o600);
                    try {
                        let at = 0;
                        while (at < bytes.length) {
                            const n = await handle.write(bytes, at, bytes.length - at);
                            if (!n.bytesWritten)
                                return bad();
                            at += n.bytesWritten;
                        }
                    }
                    finally {
                        await handle.close();
                    }
                }
                file.offset += bytes.length;
                file.complete = part.complete;
            }
            this.resourceCursor = page.nextCursor;
        }
        const file = this.files.get(seq)!;
        if (file.size !== record.size || file.sha256 !== record.sha256)
            return bad();
        const bytes = file.bytes ?? await readFile(file.path);
        if (bytes.length !== record.size || sha(bytes) !== record.sha256)
            return bad();
        this.files.delete(seq);
        if (!file.bytes)
            await rm(file.path, {
                force: true
            });
        return bytes;
    }
    async restore(parsed: Awaited<ReturnType<typeof validateRecovery>>, mappings: {
        sourceId: string;
        destinationId: string;
    }[], resume: {
        id?: string;
    }, onId: (id: string) => void) {
        const root = createHash('sha256');
        let group = createHash('sha256'), count = 0;
        for (const [seq, entry] of parsed.rows.entries()) {
            group.update(JSON.stringify([seq, entry.size, entry.sha256]) + '\n');
            if (++count % 256 === 0) {
                root.update(group.digest('hex'));
                group = createHash('sha256');
            }
        }
        if (count % 256)
            root.update(group.digest('hex'));
        const stream: RecoveryRestoreStream = {
            header: parsed.header, records: parsed.rows.length, inventoryDigest: root.digest('hex'),
            metadata: async function* () { for (const [seq, entry] of parsed.rows.entries()) {
                const bytes = await readFile(entry.file);
                if (bytes.length !== entry.size || sha(bytes) !== entry.sha256)
                    return bad();
                yield {
                    seq, bytes
                };
            } },
            resources: async function* () { for (const [seq, entry] of parsed.rows.entries()) {
                const record = await readRecoveryRecord(entry);
                if (record.type !== 'file')
                    continue;
                const payload = parsed.payloads.get(record.payload);
                if (!payload)
                    return bad();
                yield {
                    seq, record, read: async (offset, length) => { const file = await open(payload.file, 'r'); try {
                        const bytes = Buffer.alloc(length);
                        let at = 0;
                        while (at < length) {
                            const n = await file.read(bytes, at, length - at, offset + at);
                            if (!n.bytesRead)
                                return bad();
                            at += n.bytesRead;
                        }
                        return bytes;
                    }
                    finally {
                        await file.close();
                    } }
                };
            } }
        };
        return this.restoreStream(stream, mappings, resume, onId);
    }
    async restoreStream(stream: RecoveryRestoreStream, mappings: {
        sourceId: string;
        destinationId: string;
    }[], resume: {
        id?: string;
    }, onId: (id: string) => void) {
        const made = resume.id ? {
            id: resume.id
        } : await this.request('/admin/recovery/restores', {
            header: stream.header, mappings: mappings.slice(0, 50), records: stream.records, inventoryDigest: stream.inventoryDigest
        });
        const id = String(made.id);
        resume.id = id;
        onId(id);
        const initial = await this.request(`/admin/recovery/restores/${id}/renew`, {}), binding = transferBinding(initial.binding);
        if (binding.id !== id || binding.sourceId !== stream.header.sourceId || binding.records !== stream.records || binding.digest !== sha(JSON.stringify({
            id, sourceId: stream.header.sourceId, records: stream.records, inventory: stream.inventoryDigest
        })))
            return bad();
        if (initial.phase === 'staging') {
            for (let at = 0; at < mappings.length; at += 50)
                await this.request(`/admin/recovery/restores/${id}/mappings`, {
                    mappings: mappings.slice(at, at + 50)
                });
            let items: RecoveryTransferPart[] = [], raw = 0;
            const flush = async (kind: RecoveryTransferBatch['kind']) => {
                if (!items.length)
                    return;
                const cursor = transferCursor(binding, kind, items[0]!.seq, items[0]!.offset), batch = {
                    binding, kind, cursor, items
                }, body = {
                    ...batch, digest: sha(batchContent(batch))
                };
                for (;;) {
                    const progress = transferProgress(await this.request(`/admin/recovery/restores/${id}/batch`, body));
                    if (JSON.stringify(progress.binding) !== JSON.stringify(binding))
                        return bad();
                    if (progress.cursor !== cursor)
                        break;
                    this.signal.throwIfAborted();
                }
                items = [];
                raw = 0;
            };
            const root = createHash('sha256');
            let group = createHash('sha256'), count = 0;
            for await (const { seq, bytes: rawBytes } of stream.metadata()) {
                const bytes = Buffer.from(rawBytes);
                if (seq !== count || bytes.length > transferLimits.record)
                    return bad();
                group.update(JSON.stringify([seq, bytes.length, sha(bytes)]) + '\n');
                if (++count % 256 === 0) {
                    root.update(group.digest('hex'));
                    group = createHash('sha256');
                }
                if (items.length === transferLimits.metadata || raw + bytes.length > transferLimits.raw)
                    await flush('metadata');
                items.push({
                    seq, offset: 0, size: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64'), complete: true
                });
                raw += bytes.length;
            }
            if (count % 256)
                root.update(group.digest('hex'));
            if (count !== stream.records || root.digest('hex') !== stream.inventoryDigest)
                return bad();
            await flush('metadata');
            for await (const { seq, record, read } of stream.resources()) {
                let offset = 0;
                do {
                    if (items.length === transferLimits.resources || raw === transferLimits.raw || (transferLimits.raw - raw < 24000 && record.size - offset > transferLimits.raw - raw))
                        await flush('resources');
                    const length = Math.min(record.size - offset, transferLimits.raw - raw), bytes = Buffer.from(await read(offset, length));
                    if (bytes.length !== length)
                        return bad();
                    items.push({
                        seq, offset, size: record.size, sha256: record.sha256, base64: bytes.toString('base64'), complete: offset + length === record.size
                    });
                    raw += length;
                    offset += length;
                } while (offset < record.size);
            }
            await flush('resources');
        }
        for (;;) {
            const progress = transferProgress(await this.request(`/admin/recovery/restores/${id}/prepare`, {}));
            if (progress.phase === 'ready' || progress.phase === 'committed')
                break;
        }
        return this.request(`/admin/recovery/restores/${id}/commit`, {});
    }
}
