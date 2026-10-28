import { assertLocalPayload, registerLocalPayload } from './retention-schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { crc32, inflateSync } from 'node:zlib';
import { AppError } from '../../contracts/src/model.js';
import type { Principal, ArtifactFile } from '../../contracts/src/model.js';
import type { ImportRowView } from '../../contracts/src/import.js';
import { rowFingerprint, importLimits } from '../../contracts/src/import.js';
import { parseImport, validateRows } from '../../core/src/import/rows.js';
import { authorize } from '../../core/src/permissions.js';
import { object, integer, string, uuid } from '../../contracts/src/http.js';
import type { LocalBatches, LocalDraft } from './local-batches.js';
interface Resource {
    id: string;
    name: string;
    size: number;
    sha256: string;
    complete: boolean;
    draftId?: string;
    rowNumber?: number;
    revision?: number;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Validate the one header pngjs will consume, then bound inflation before its allocations. */
function logoPreflight(bytes: Buffer, limits = { bytes: 2000000, width: 2048, height: 2048 }) {
    if (bytes.length < 45 || bytes.length > limits.bytes || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
        throw new Error('PNG source size/signature');
    let width = 0, height = 0, depth = 0, channels = 0, interlace = 0, ended = false, dataEnded = false;
    const idat: Buffer[] = [];
    for (let offset = 8; offset < bytes.length;) {
        if (bytes.length - offset < 12)
            throw new Error('Truncated PNG chunk');
        const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
        if (end > bytes.length)
            throw new Error('Truncated PNG chunk payload');
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
            throw new Error('Invalid PNG chunk type/CRC');
        if (type === 'IHDR') {
            if (offset !== 8 || length !== 13)
                throw new Error('Duplicate/malformed IHDR');
            width = bytes.readUInt32BE(offset + 8);
            height = bytes.readUInt32BE(offset + 12);
            depth = bytes[offset + 16]!;
            const color = bytes[offset + 17]!;
            const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color] ?? 0;
            interlace = bytes[offset + 20]!;
            if (width < 1 || width > limits.width || height < 1 || height > limits.height || !depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || interlace > 1)
                throw new Error('Unsupported PNG header');
        }
        else if (!width) {
            throw new Error('IHDR must be first');
        }
        if (type === 'IDAT') {
            if (dataEnded)
                throw new Error('Noncontiguous IDAT');
            idat.push(bytes.subarray(offset + 8, end - 4));
        }
        else if (idat.length) {
            dataEnded = true;
        }
        if (type === 'IEND') {
            if (length !== 0 || end !== bytes.length || !idat.length)
                throw new Error('Invalid PNG end');
            ended = true;
        }
        offset = end;
    }
    if (!ended)
        throw new Error('Missing PNG end');
    // RGBA16 is pngjs's largest decoded bitmap; Adam7 adds one filter byte per pass row.
    const decodedBytes = width * height * 4 * (depth === 16 ? 2 : 1);
    const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    let inflatedBytes = 0;
    for (const [x, y, dx, dy] of passes as [
        number,
        number,
        number,
        number
    ][]) {
        const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
        if (w && h)
            inflatedBytes += (Math.ceil(w * channels * depth / 8) + 1) * h;
    }
    if (decodedBytes > 32 * 1024 * 1024 || inflatedBytes > 34 * 1024 * 1024)
        throw new Error('PNG bitmap budget');
    // pngjs's interlaced path otherwise uses an unbounded inflateSync. Validate the exact
    // immutable compressed stream first, including its scanline length, for both paths.
    const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: inflatedBytes });
    if (inflated.length !== inflatedBytes)
        throw new Error('Invalid PNG scanline length');
    return { width, height };
}
export function decodeLogo(bytes: Buffer): ArtifactFile {
    try {
        const header = logoPreflight(bytes);
        const decoded = PNG.sync.read(bytes, { checkCRC: true });
        if (decoded.width !== header.width || decoded.height !== header.height || decoded.data.byteLength > 32 * 1024 * 1024)
            throw new Error('PNG decoder/header mismatch');
    }
    catch (error) {
        throw new AppError('INVALID_INPUT', 'Логотип: корректный PNG до 2 МБ и 2048 × 2048 пикселей.', { cause: error });
    }
    return { path: 'assets/logo.png', bytes: new Uint8Array(bytes), mediaType: 'image/png' };
}
export function verifyValidationPng(bytes: Uint8Array) { try {
    const header = logoPreflight(Buffer.from(bytes), { bytes: 8000000, width: 1440, height: 900 });
    if (![375, 1440].includes(header.width) || header.height !== 900)
        throw new Error('Validation viewport mismatch');
    const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
    if (decoded.width !== header.width || decoded.height !== 900)
        throw new Error('PNG mismatch');
    return header;
}
catch (error) {
    throw new AppError('INVALID_INPUT', 'Снимок проверки: PNG375/1440×900 до8МБ.', { cause: error });
} }
export class LocalImportResources {
    constructor(readonly batches: LocalBatches) { }
    private resource(actor: Principal, id: string): Resource {
        const row = this.batches.db.sql.prepare('select owner_id,data from resources where id=?').get(id);
        if (!row)
            throw new AppError('NOT_FOUND', 'Ресурс не найден.');
        if (row.owner_id !== actor.userId)
            throw new AppError('FORBIDDEN', 'Чужой ресурс.');
        assertLocalPayload(this.batches.db.sql, { kind: 'resource', id });
        return JSON.parse(String(row.data)) as Resource;
    }
    private bytes(resource: Resource) {
        assertLocalPayload(this.batches.db.sql, { kind: 'resource', id: resource.id });
        const rows = this.batches.db.sql.prepare('select part,bytes from chunks where resource_id=? order by part').all(resource.id);
        if (rows.some((r, i) => r.part !== i))
            throw new AppError('INVALID_INPUT', 'Не хватает фрагментов.');
        const bytes = Buffer.concat(rows.map(r => Buffer.from(r.bytes as Uint8Array)));
        if (bytes.length !== resource.size || hash(bytes) !== resource.sha256)
            throw new AppError('INVALID_INPUT', 'Размер или хеш файла не совпадает.');
        return bytes;
    }
    private revalidate(id: string, views: ImportRowView[], draft: LocalDraft, originals: Map<number, string>) {
        const parsed = validateRows(views.map(r => r.input), views.flatMap(r => r.issues));
        for (const r of views) {
            r.issues = parsed.issues.filter(i => i.rowNumber === r.rowNumber);
            if (originals.get(r.rowNumber) !== rowFingerprint(r))
                this.batches.putRow(id, r);
        }
        draft.summary.invalidCount = new Set(parsed.issues.map(i => i.rowNumber)).size;
        draft.summary.validCount = views.length - draft.summary.invalidCount;
        draft.summary.revision++;
        this.batches.save(draft);
    }
    async request(actor: Principal, method: string, value: unknown): Promise<unknown> {
        authorize(actor, 'site:create');
        const db = this.batches.db;
        if (method === 'resource.begin') {
            const p = object(value, ['name', 'size', 'sha256', 'draftId', 'rowNumber', 'revision']), name = string(p.name, 200), logo = p.draftId !== undefined;
            if (!(logo ? /\.png$/i : /\.(csv|xlsx)$/i).test(name) || !/^[a-f0-9]{64}$/.test(String(p.sha256)))
                throw new AppError('INVALID_INPUT', 'Некорректный файл.');
            const id = randomUUID(), r: Resource = { id, name, size: integer(p.size, 1, logo ? 2000000 : importLimits.sourceBytes), sha256: String(p.sha256), complete: false };
            db.transaction(() => {
                if (logo) {
                    const draftId = uuid(p.draftId), d = this.batches.read(actor, draftId, true);
                    if (d.summary.state !== 'preview' || d.summary.revision !== integer(p.revision))
                        throw new AppError('CONFLICT', 'Предпросмотр изменился.');
                    const rowNumber = integer(p.rowNumber, 2, 5001);
                    if (!this.batches.rows(draftId).some(r => r.rowNumber === rowNumber))
                        throw new AppError('NOT_FOUND', 'Строка не найдена.');
                    Object.assign(r, { draftId, rowNumber, revision: d.summary.revision });
                }
                registerLocalPayload(db.sql, { kind: 'resource', id, siteId: null, createdAt: Date.now(), protectUntil: Date.now() + 600000, state: 'staging', firstOrphanAt: null, claimToken: null, objects: [{ key: 'database:chunks:' + id, size: r.size, sha256: r.sha256, mediaType: logo ? 'image/png' : 'application/octet-stream' }] });
                db.sql.prepare('insert into resources values(?,?,?)').run(id, actor.userId, JSON.stringify(r));
            });
            return { id };
        }
        if (method === 'resource.chunk') {
            const p = object(value, ['id', 'index', 'base64']), id = uuid(p.id), index = integer(p.index, 0, Math.ceil(importLimits.sourceBytes / importLimits.chunkBytes) - 1), base64 = string(p.base64, 32000), bytes = Buffer.from(base64, 'base64');
            if (bytes.toString('base64') !== base64 || bytes.length > importLimits.chunkBytes)
                throw new AppError('INVALID_INPUT', 'Некорректный фрагмент.');
            db.transaction(() => {
                const r = this.resource(actor, id);
                if (r.complete)
                    throw new AppError('CONFLICT', 'Ресурс уже завершён.');
                const old = db.sql.prepare('select bytes from chunks where resource_id=? and part=?').get(id, index);
                if (old) {
                    if (!Buffer.from(old.bytes as Uint8Array).equals(bytes))
                        throw new AppError('CONFLICT', 'Фрагмент уже существует.');
                    return;
                }
                const size = Number(db.sql.prepare('select coalesce(sum(length(bytes)),0) size from chunks where resource_id=?').get(id)!.size);
                if (size + bytes.length > r.size)
                    throw new AppError('INVALID_INPUT', 'Превышен размер ресурса.');
                db.sql.prepare('insert into chunks values(?,?,?)').run(id, index, bytes);
            });
            return { ok: true };
        }
        if (method === 'import.prepare') {
            const p = object(value, ['id']), id = uuid(p.id), r = this.resource(actor, id);
            if (r.draftId)
                throw new AppError('INVALID_INPUT', 'Ресурс предназначен для логотипа.');
            if (r.complete)
                return this.batches.get(actor, id);
            const parsed = await parseImport({ name: r.name, bytes: this.bytes(r) });
            const invalid = new Set(parsed.issues.map(i => i.rowNumber)).size;
            db.transaction(() => {
                const current = this.resource(actor, id);
                if (current.complete)
                    return;
                const draft: LocalDraft = { summary: { id, name: r.name, revision: 1, state: 'preview', total: parsed.rows.length, validCount: parsed.rows.length - invalid, invalidCount: invalid, canControl: true }, assignedUserIds: [], hash: r.sha256 };
                db.sql.prepare('insert into batches values(?,?,?,?,?,?) on conflict(id) do nothing').run(id, actor.userId, null, null, 'uploading', JSON.stringify({ ...draft, summary: { ...draft.summary, state: 'uploading' } }));
            });
            for (let offset = 0; offset < parsed.rows.length; offset += 50) {
                db.transaction(() => {
                    if (this.batches.read(actor, id, true).summary.state !== 'uploading')
                        return;
                    for (const input of parsed.rows.slice(offset, offset + 50))
                        this.batches.putRow(id, { rowNumber: input.rowNumber, input, issues: parsed.issues.filter(i => i.rowNumber === input.rowNumber), siteId: null, job: null });
                });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            db.transaction(() => { const draft = this.batches.read(actor, id, true); draft.summary.state = 'preview'; this.batches.save(draft); r.complete = true; assertLocalPayload(db.sql, { kind: 'resource', id: r.id }); db.sql.prepare("update payload_inventory set state='available' where kind='resource' and id=?").run(r.id); db.sql.prepare('update resources set data=? where id=?').run(JSON.stringify(r), id); });
            return this.batches.get(actor, id);
        }
        if (method === 'import.update') {
            const p = object(value, ['id', 'revision', 'rowNumber', 'about', 'domain', 'referenceId']), id = uuid(p.id);
            db.transaction(() => {
                const d = this.batches.read(actor, id, true);
                if (d.summary.state !== 'preview' || d.summary.revision !== integer(p.revision))
                    throw new AppError('CONFLICT', 'Предпросмотр изменился.');
                const rows = this.batches.rows(id), originals = new Map(rows.map(r => [r.rowNumber, rowFingerprint(r)])), row = rows.find(r => r.rowNumber === integer(p.rowNumber, 2, 5001));
                if (!row)
                    throw new AppError('NOT_FOUND', 'Строка не найдена.');
                for (const field of ['about', 'domain', 'referenceId'] as const)
                    if (p[field] !== undefined) {
                        if (typeof p[field] !== 'string' || p[field].length > (field === 'domain' ? 253 : field === 'referenceId' ? 100 : 8000))
                            throw new AppError('INVALID_INPUT', 'Слишком длинное значение.');
                        row.input[field] = p[field];
                        row.issues = row.issues.filter(i => i.column !== field);
                    }
                this.revalidate(id, rows, d, originals);
            });
            return this.batches.get(actor, id);
        }
        if (method === 'logo.complete') {
            const p = object(value, ['id']), r = this.resource(actor, uuid(p.id));
            if (!r.draftId)
                throw new AppError('INVALID_INPUT', 'Это не логотип.');
            decodeLogo(this.bytes(r));
            db.transaction(() => {
                const d = this.batches.read(actor, r.draftId!, true);
                if (r.complete)
                    return;
                if (d.summary.state !== 'preview' || d.summary.revision !== r.revision)
                    throw new AppError('CONFLICT', 'Строки изменились; выберите файл повторно.');
                const views = this.batches.rows(r.draftId!), originals = new Map(views.map(r => [r.rowNumber, rowFingerprint(r)])), row = views.find(v => v.rowNumber === r.rowNumber)!;
                row.input.logoAssetId = r.id;
                r.complete = true;
                assertLocalPayload(db.sql, { kind: 'resource', id: r.id });
                db.sql.prepare("update payload_inventory set state='available' where kind='resource' and id=?").run(r.id);
                db.sql.prepare('update resources set data=? where id=?').run(JSON.stringify(r), r.id);
                this.revalidate(r.draftId!, views, d, originals);
            });
            return this.batches.get(actor, r.draftId);
        }
        if (method === 'import.commit') {
            const p = object(value, ['id', 'revision', 'requestKey']), id = uuid(p.id), requestKey = string(p.requestKey, 100), revision = integer(p.revision);
            db.transaction(() => {
                const d = this.batches.read(actor, id, true), frozen = hash(Buffer.from(JSON.stringify(this.batches.rows(id).map(r => [r.rowNumber, r.input.domain, r.input.about ?? '', r.input.referenceId ?? '', r.input.logo ?? '', r.input.logoAssetId ?? '']))));
                const old = db.sql.prepare('select id,hash from batches where owner_id=? and request_key=?').get(actor.userId, requestKey);
                if (old) {
                    if (old.id !== id || old.hash !== frozen || d.committedRevision !== revision)
                        throw new AppError('CONFLICT', 'Ключ запроса уже использован.');
                    return;
                }
                if (d.summary.state !== 'preview' || d.summary.revision !== revision || !d.summary.validCount)
                    throw new AppError('CONFLICT', 'Нет корректных строк или версия изменилась.');
                d.committedRevision = revision;
                d.summary.state = 'active';
                this.batches.save(d);
                db.sql.prepare('update batches set request_key=?,hash=? where id=?').run(requestKey, frozen, id);
            });
            await this.batches.admit(actor, id, 25);
            return { batchId: id };
        }
        throw new AppError('INVALID_INPUT', 'Неизвестная операция импорта.');
    }
    async readLogo(assetId: string, siteId: string): Promise<ArtifactFile> {
        const stored = this.batches.db.sql.prepare('select data from resources where id=?').get(assetId);
        if (!stored)
            throw new AppError('NOT_FOUND', 'Логотип не найден.');
        const r = JSON.parse(String(stored.data)) as Resource;
        const row = this.batches.db.sql.prepare('select site_id from batch_rows where batch_id=? and row_number=?').get(r.draftId ?? '', r.rowNumber ?? 0);
        if (!r.complete || row?.site_id !== siteId)
            throw new AppError('FORBIDDEN', 'Логотип другого сайта.');
        return decodeLogo(this.bytes(r));
    }
}
