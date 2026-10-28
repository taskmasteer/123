import type { PortableArchive, BackupEntry, RestoreEntry, RestoreEntries } from '../../core/src/backup.js';
import { createHash, createCipheriv, createDecipheriv, scrypt, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import type { Entry } from 'yauzl';
import { AppError } from '../../contracts/src/model.js';
import { privateDirectory } from './safe-files.js';
import { recoveryPath } from './recovery-records.js';
import { artifactPath } from '../../core/src/artifacts.js';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
// 48GiB < GCM's per-message limit (2^36-32 bytes); streaming is not unbounded.
export const maximumArchiveBytes = 48 * 1024 ** 3, maximumArchiveEntries = 1000000, maximumEntryBytes = 32 * 1024 ** 2;
export const maximumMetadataRecords = 1000000, maximumMetadataBytes = 768 * 1024 ** 2;
const maximumIndexBytes = 192 * 1024 ** 2, indexChunkBytes = 1024 ** 2, magic = Buffer.from('SFBAK001');
const failure = () => new AppError('INVALID_INPUT', 'Неверный пароль или повреждённая резервная копия.');
/** Streaming resource preflight, independent of blob allocation and ZIP compression. */
export class ArchiveCapacity {
    entries = 0;
    bytes = 0;
    metadataBytes = 0;
    metadataRecords = 0;
    indexBytes = 0;
    metadata(size: number) { this.metadataBytes += size; this.metadataRecords++; if (this.metadataBytes > maximumMetadataBytes || this.metadataRecords > maximumMetadataRecords)
        throw failure(); }
    add(name: string, size: number, sha256: string) {
        backupName(name);
        if (!Number.isSafeInteger(size) || size < 0 || size > maximumEntryBytes || !/^[a-f0-9]{64}$/.test(sha256))
            throw failure();
        this.entries++;
        this.bytes += size;
        this.indexBytes += Buffer.byteLength(JSON.stringify({ name, size, sha256 }) + '\n');
        if (name.startsWith('records/')) {
            this.metadata(size);
        }
        if (this.bytes > maximumArchiveBytes || this.entries + Math.ceil(this.indexBytes / indexChunkBytes) > maximumArchiveEntries || this.metadataBytes > maximumMetadataBytes || this.metadataRecords > maximumMetadataRecords || this.indexBytes > maximumIndexBytes)
            throw new AppError('INVALID_INPUT', 'Копия превышает техническую ёмкость одного зашифрованного файла.');
    }
}
const sum = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Private disk index: input entry count never determines the live JS heap. */
export class ArchiveInventory {
    readonly db: DatabaseSync;
    readonly capacity = new ArchiveCapacity();
    private readonly insertName: StatementSync;
    private readonly insertValue: StatementSync;
    private readonly removeValue: StatementSync;
    constructor(path: string) { this.db = new DatabaseSync(path); this.db.exec('pragma journal_mode=off;pragma cache_size=-4096;pragma temp_store=file;create table names(name text primary key) without rowid;create table inventory(name text primary key,size integer not null,sha256 text not null,file_descriptor text,used integer not null default 0) without rowid;create table bindings(payload text primary key,record_name text unique) without rowid;begin'); this.insertName = this.db.prepare('insert into names values(?)'); this.insertValue = this.db.prepare('insert into inventory(name,size,sha256,file_descriptor) values(?,?,?,?)'); this.removeValue = this.db.prepare('update inventory set used=1 where name=? and used=0 returning *'); }
    name(name: string) { try {
        this.insertName.run(name);
    }
    catch {
        throw failure();
    } }
    add(value: {
        name: string;
        size: number;
        sha256: string;
        fileDescriptorV1?: EmbeddedFile;
    }) {
        this.capacity.add(value.name, value.size, value.sha256);
        try {
            if (Object.hasOwn(value, 'fileDescriptorV1')) {
                const file = validateEmbedded(value.name, value.fileDescriptorV1);
                this.name(file.recordName);
                this.capacity.metadata(encodedDescriptor(value, file).length);
                this.db.prepare('insert into bindings values(?,?)').run(value.name, file.recordName);
            }
            this.insertValue.run(value.name, value.size, value.sha256, value.fileDescriptorV1 ? JSON.stringify(value.fileDescriptorV1) : null);
        }
        catch {
            throw failure();
        }
    }
    take(name: string) {
        return this.removeValue.get(name) as {
            name: string;
            size: number;
            sha256: string;
            file_descriptor: string | null;
        } | undefined;
    }
    explicit(name: string, value: any) { const file = explicitDescriptor(name, value), payload = this.db.prepare('select size,sha256 from inventory where name=?').get(value.payload); if (!payload || payload.size !== value.size || payload.sha256 !== value.sha256)
        throw failure(); try {
        this.db.prepare('insert into bindings values(?,?)').run(value.payload, file.recordName);
    }
    catch {
        throw failure();
    } }
    remaining() { return Number(this.db.prepare('select count(*) n from inventory where used=0').get()!.n); }
    close() { try {
        if (this.db.isTransaction)
            this.db.exec('commit');
    }
    finally {
        this.db.close();
    } }
}
type EmbeddedFile = {
    recordName: string;
    root: 'data' | 'catalog' | 'object';
    path: string;
    mediaType: string;
};
function validateEmbedded(payload: string, value: any): EmbeddedFile { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'mediaType,path,recordName,root' || typeof payload !== 'string' || !/^payloads\/[0-9]{1,12}\.bin$/.test(payload) || typeof value.recordName !== 'string' || !/^records\/(0|[1-9][0-9]{0,5})\.json$/.test(value.recordName) || !['data', 'catalog', 'object'].includes(value.root) || typeof value.mediaType !== 'string' || value.mediaType.length > 100 || !value.mediaType || /[\x00-\x1f]/.test(value.mediaType))
    throw failure(); recoveryPath(value.path); return value; }
function encodedDescriptor(payload: {
    name: string;
    size: number;
    sha256: string;
}, file: EmbeddedFile) { return Buffer.from(JSON.stringify({ type: 'file', root: file.root, path: file.path, payload: payload.name, size: payload.size, sha256: payload.sha256, mediaType: file.mediaType })); }
function explicitDescriptor(recordName: string, value: any): EmbeddedFile { if (Object.keys(value).sort().join(',') !== 'mediaType,path,payload,root,sha256,size,type' || value.type !== 'file' || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maximumEntryBytes || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))
    throw failure(); return validateEmbedded(value.payload, { recordName, root: value.root, path: value.path, mediaType: value.mediaType }); }
function backupName(name: string) { if (!/^(records\/[0-9]{1,12}\.json|payloads\/[0-9]{1,12}\.bin)$/.test(name))
    throw failure(); return name; }
function bound(maximum: number) { let total = 0; return new Transform({ transform(chunk: Buffer, _encoding, callback) { total += chunk.length; callback(total > maximum ? failure() : null, chunk); } }); }
/** ZIP STORE/ZIP64 only. PKWARE APPNOTE6.3.10 sections4.3/4.5.3; no append/compression/encryption features. */
export async function writeFully(file: Pick<Awaited<ReturnType<typeof open>>, 'write'>, bytes: Uint8Array) { let offset = 0; while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten <= 0)
        throw failure();
    offset += result.bytesWritten;
} }
export async function writeZip(path: string, entries: AsyncIterable<BackupEntry>, indexPath?: string) {
    const suffix = randomUUID(), centralPath = path + '.central-' + suffix, namesPath = path + '.names-' + suffix, names = new ArchiveInventory(namesPath), output = await open(path, 'wx', 0o600).catch(async (error) => { names.close(); await rm(namesPath, { force: true }); throw error; }), central = await open(centralPath, 'wx', 0o600).catch(async (error) => { await output.close(); names.close(); await rm(namesPath, { force: true }); await rm(path, { force: true }); throw error; });
    let offset = 0, count = 0, centralBytes = 0, indexTotal = 0, indexBytes = 0, indexOrdinal = 0, index: Awaited<ReturnType<typeof open>> | null = null;
    const capacity = new ArchiveCapacity();
    let success = false;
    let pending: {
        file: EmbeddedFile;
        payload: string;
        size: number;
        sha256: string;
    } | null = null;
    async function append(name: string, bytes: Uint8Array) {
        names.name(name.toLowerCase());
        if (++count > maximumArchiveEntries || offset + bytes.length > maximumArchiveBytes)
            throw failure();
        const encoded = Buffer.from(name, 'utf8'), crc = crc32(bytes), local = Buffer.alloc(30 + encoded.length + 20);
        local.writeUInt32LE(0x04034b50);
        local.writeUInt16LE(45, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(33, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(0xffffffff, 18);
        local.writeUInt32LE(0xffffffff, 22);
        local.writeUInt16LE(encoded.length, 26);
        local.writeUInt16LE(20, 28);
        encoded.copy(local, 30);
        let extra = 30 + encoded.length;
        local.writeUInt16LE(1, extra);
        local.writeUInt16LE(16, extra + 2);
        local.writeBigUInt64LE(BigInt(bytes.length), extra + 4);
        local.writeBigUInt64LE(BigInt(bytes.length), extra + 12);
        const cd = Buffer.alloc(46 + encoded.length + 28);
        cd.writeUInt32LE(0x02014b50);
        cd.writeUInt16LE((3 << 8) | 45, 4);
        cd.writeUInt16LE(45, 6);
        cd.writeUInt16LE(0x800, 8);
        cd.writeUInt16LE(33, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(0xffffffff, 20);
        cd.writeUInt32LE(0xffffffff, 24);
        cd.writeUInt16LE(encoded.length, 28);
        cd.writeUInt16LE(28, 30);
        cd.writeUInt32LE((0o100600 << 16) >>> 0, 38);
        cd.writeUInt32LE(0xffffffff, 42);
        encoded.copy(cd, 46);
        extra = 46 + encoded.length;
        cd.writeUInt16LE(1, extra);
        cd.writeUInt16LE(24, extra + 2);
        cd.writeBigUInt64LE(BigInt(bytes.length), extra + 4);
        cd.writeBigUInt64LE(BigInt(bytes.length), extra + 12);
        cd.writeBigUInt64LE(BigInt(offset), extra + 20);
        await writeFully(output, local);
        await writeFully(output, bytes);
        await writeFully(central, cd);
        offset += local.length + bytes.length;
        centralBytes += cd.length;
        if (offset + centralBytes + 98 > maximumArchiveBytes)
            throw failure();
    }
    async function flush() {
        if (!index)
            return;
        await index.close();
        index = null;
        const file = indexPath! + '.' + indexOrdinal;
        await append('indexes/' + indexOrdinal++ + '.ndjson', await readFile(file));
        await rm(file);
        indexBytes = 0;
    }
    try {
        for await (const entry of entries) {
            (indexPath ? backupName : artifactPath)(entry.name);
            if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maximumEntryBytes || !/^[a-f0-9]{64}$/.test(entry.sha256))
                throw failure();
            const bytes = await entry.read();
            if (bytes.length !== entry.size || sum(bytes) !== entry.sha256)
                throw failure();
            let embedded: EmbeddedFile | undefined;
            if (indexPath && entry.name.startsWith('records/')) {
                const record = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
                if (record.type === 'file') {
                    if (pending)
                        throw failure();
                    const file = explicitDescriptor(entry.name, record);
                    names.name(entry.name);
                    capacity.metadata(bytes.length);
                    pending = { file, payload: record.payload, size: record.size, sha256: record.sha256 };
                    continue;
                }
            }
            if (pending) {
                if (entry.name !== pending.payload || entry.size !== pending.size || entry.sha256 !== pending.sha256)
                    throw failure();
                embedded = pending.file;
                pending = null;
            }
            if (indexPath)
                capacity.add(entry.name, entry.size, entry.sha256);
            await append(entry.name, bytes);
            if (indexPath) {
                const line = Buffer.from(JSON.stringify({ name: entry.name, size: entry.size, sha256: entry.sha256, ...(embedded ? { fileDescriptorV1: embedded } : {}) }) + '\n');
                if (indexBytes + line.length > indexChunkBytes)
                    await flush();
                if (!index)
                    index = await open(indexPath + '.' + indexOrdinal, 'wx', 0o600);
                indexBytes += line.length;
                indexTotal += line.length;
                if (indexTotal > maximumIndexBytes)
                    throw failure();
                await writeFully(index, line);
            }
        }
        if (pending)
            throw failure();
        await flush();
        await central.close();
        const start = offset;
        for await (const part of createReadStream(centralPath)) {
            await writeFully(output, part);
            offset += part.length;
        }
        const end = Buffer.alloc(98);
        end.writeUInt32LE(0x06064b50);
        end.writeBigUInt64LE(44n, 4);
        end.writeUInt16LE((3 << 8) | 45, 12);
        end.writeUInt16LE(45, 14);
        end.writeBigUInt64LE(BigInt(count), 24);
        end.writeBigUInt64LE(BigInt(count), 32);
        end.writeBigUInt64LE(BigInt(centralBytes), 40);
        end.writeBigUInt64LE(BigInt(start), 48);
        end.writeUInt32LE(0x07064b50, 56);
        end.writeBigUInt64LE(BigInt(offset), 64);
        end.writeUInt32LE(1, 72);
        end.writeUInt32LE(0x06054b50, 76);
        end.writeUInt16LE(0xffff, 84);
        end.writeUInt16LE(0xffff, 86);
        end.writeUInt32LE(0xffffffff, 88);
        end.writeUInt32LE(0xffffffff, 92);
        await writeFully(output, end);
        await output.sync();
        success = true;
    }
    finally {
        await index?.close().catch(() => { });
        await central.close().catch(() => { });
        await output.close();
        names.close();
        await rm(centralPath, { force: true });
        await rm(namesPath, { force: true });
        if (indexPath)
            await rm(indexPath + '.' + indexOrdinal, { force: true });
        if (!success)
            await rm(path, { force: true });
    }
}
async function keyFor(passphrase: string, salt: Buffer) { const bytes = Buffer.from(passphrase, 'utf8'); if (bytes.length < 8 || bytes.length > 1024)
    throw new AppError('INVALID_INPUT', 'Пароль должен занимать от 8 до 1024 байт UTF-8.'); try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(bytes, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
finally {
    bytes.fill(0);
} }
async function zipEntries(path: string, inventory: ArchiveInventory) {
    const file = await open(path, 'r');
    try {
        const size = (await file.stat()).size, tail = Buffer.alloc(22);
        await file.read(tail, 0, 22, size - 22);
        if (tail.readUInt32LE(0) !== 0x06054b50 || tail.readUInt16LE(20) !== 0)
            throw failure();
    }
    finally {
        await file.close();
    }
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error || !value ? reject(error ?? failure()) : resolve(value)));
    try {
        const indexes = await new Promise<Entry[]>((resolve, reject) => { const indexes: Entry[] = []; let total = 0, count = 0; zip.on('error', reject); zip.on('entry', (entry: Entry) => { try {
            if (count++ >= maximumArchiveEntries || entry.compressionMethod !== 0 || (entry.generalPurposeBitFlag & 1) !== 0 || entry.compressedSize !== entry.uncompressedSize || entry.uncompressedSize > maximumEntryBytes || entry.uncompressedSize < 0 || entry.comment.length || (((entry.externalFileAttributes >>> 16) & 0o170000) !== 0o100000))
                throw failure();
            inventory.name(entry.fileName);
            if (/^indexes\/[0-9]+\.ndjson$/.test(entry.fileName)) {
                if (indexes.length >= 256 || entry.uncompressedSize > indexChunkBytes)
                    throw failure();
                indexes.push(entry);
            }
            else
                backupName(entry.fileName);
            total += entry.uncompressedSize;
            if (total > maximumArchiveBytes)
                throw failure();
            zip.readEntry();
        }
        catch (error) {
            reject(error);
        } }); zip.on('end', () => resolve(indexes)); zip.readEntry(); });
        return { zip, indexes };
    }
    catch (error) {
        zip.close();
        throw error;
    }
}
const readEntry = (zip: yauzl.ZipFile, entry: Entry) => new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? failure()) : resolve(stream)));
async function extractVerified(path: string, directory: string): Promise<RestoreEntries> {
    const inventory = new ArchiveInventory(join(directory, 'inventory.sqlite'));
    try {
        return await extractIndexed(path, directory, inventory);
    }
    finally {
        inventory.close();
        await rm(join(directory, 'inventory.sqlite'), { force: true });
    }
}
async function extractIndexed(path: string, directory: string, inventory: ArchiveInventory): Promise<RestoreEntries> {
    const first = await zipEntries(path, inventory);
    let indexTotal = 0;
    try {
        if (!first.indexes.length)
            throw failure();
        const indexes = first.indexes.sort((a, b) => Number(a.fileName.split('/')[1]!.split('.')[0]) - Number(b.fileName.split('/')[1]!.split('.')[0]));
        for (const [ordinal, index] of indexes.entries()) {
            if (index.fileName !== 'indexes/' + ordinal + '.ndjson')
                throw failure();
            const chunks: Buffer[] = [];
            let length = 0;
            for await (const part of await readEntry(first.zip, index)) {
                length += part.length;
                indexTotal += part.length;
                if (length > indexChunkBytes || indexTotal > maximumIndexBytes)
                    throw failure();
                chunks.push(Buffer.from(part));
            }
            if (crc32(Buffer.concat(chunks)) !== index.crc32)
                throw failure();
            for (const line of new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)).split('\n').filter(Boolean)) {
                const value = JSON.parse(line);
                if (!value || typeof value !== 'object' || !['name,sha256,size', 'fileDescriptorV1,name,sha256,size'].includes(Object.keys(value).sort().join(',')))
                    throw failure();
                inventory.add(value);
            }
        }
    }
    finally {
        first.zip.close();
        first.zip.removeAllListeners('entry');
        first.zip.removeAllListeners('end');
    }
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, value) => error || !value ? reject(error ?? failure()) : resolve(value)));
    const descriptorPath = join(directory, 'entries.sqlite'), descriptors = new DatabaseSync(descriptorPath);
    descriptors.exec('pragma journal_mode=off;pragma cache_size=-4096;create table entries(seq integer primary key,name text unique,size integer,sha256 text,file text);begin');
    let count = 0;
    try {
        while (true) {
            const entry = await new Promise<Entry | null>((resolve, reject) => { const cleanup = () => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError); }, onEntry = (entry: Entry) => { cleanup(); resolve(entry); }, onEnd = () => { cleanup(); resolve(null); }, onError = (error: Error) => { cleanup(); reject(error); }; zip.once('entry', onEntry); zip.once('end', onEnd); zip.once('error', onError); zip.readEntry(); });
            if (!entry)
                break;
            if (entry.fileName.startsWith('indexes/'))
                continue;
            const expected = inventory.take(entry.fileName);
            if (!expected || expected.size !== entry.uncompressedSize)
                throw failure();
            const file = join(directory, 'entry-' + count), hash = createHash('sha256');
            let size = 0, crc = 0;
            const checked = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; hash.update(chunk); crc = crc32(chunk, crc); callback(size > expected.size ? failure() : null, chunk); } });
            await pipeline(await readEntry(zip, entry), checked, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
            if (size !== expected.size || crc !== entry.crc32 || hash.digest('hex') !== expected.sha256)
                throw failure();
            if (expected.name.startsWith('records/')) {
                const record = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await readFile(file)));
                if (record?.type === 'file')
                    inventory.explicit(expected.name, record);
            }
            descriptors.prepare('insert into entries values(?,?,?,?,?)').run(count++, expected.name, expected.size, expected.sha256, file);
            if (expected.file_descriptor) {
                const descriptor = validateEmbedded(expected.name, JSON.parse(expected.file_descriptor)), bytes = encodedDescriptor(expected, descriptor), metadataFile = join(directory, 'entry-' + count);
                const target = await open(metadataFile, 'wx', 0o600);
                try {
                    await writeFully(target, bytes);
                }
                finally {
                    await target.close();
                }
                descriptors.prepare('insert into entries values(?,?,?,?,?)').run(count++, descriptor.recordName, bytes.length, sum(bytes), metadataFile);
            }
        }
        if (inventory.remaining())
            throw failure();
        descriptors.exec('commit');
        return new DiskRestoreEntries(descriptorPath, count);
    }
    finally {
        zip.close();
        descriptors.close();
    }
}
export class DiskRestoreEntries implements RestoreEntries {
    constructor(readonly path: string, readonly length: number) { }
    at(index: number) { const db = new DatabaseSync(this.path, { readOnly: true }); try {
        return db.prepare('select name,size,sha256,file from entries where seq=?').get(index) as RestoreEntry | undefined;
    }
    finally {
        db.close();
    } }
    *[Symbol.iterator]() { const db = new DatabaseSync(this.path, { readOnly: true }); try {
        for (const row of db.prepare('select name,size,sha256,file from entries order by seq').iterate())
            yield row as unknown as RestoreEntry;
    }
    finally {
        db.close();
    } }
}
export function portableArchive(directory: string): PortableArchive {
    return {
        async create(passphrase, entries) {
            if (typeof passphrase !== 'string' || Buffer.byteLength(passphrase, 'utf8') < 8 || Buffer.byteLength(passphrase, 'utf8') > 1024)
                throw new AppError('INVALID_INPUT', 'Пароль должен занимать от 8 до 1024 байт UTF-8.');
            const root = await privateDirectory(directory), stage = await mkdtemp(join(root, '.backup-')), plain = join(stage, 'archive.zip'), output = join(root, randomUUID() + '.sfbak');
            let key: Buffer | undefined;
            try {
                await writeZip(plain, entries, join(stage, 'index.ndjson'));
                const size = (await stat(plain)).size;
                if (size > maximumArchiveBytes)
                    throw failure();
                const salt = randomBytes(16), iv = randomBytes(12), header = Buffer.alloc(64);
                magic.copy(header);
                header.writeUInt32BE(131072, 8);
                header.writeUInt32BE(8, 12);
                header.writeUInt32BE(1, 16);
                salt.copy(header, 20);
                iv.copy(header, 36);
                header.writeBigUInt64BE(BigInt(size), 48);
                key = await keyFor(passphrase, salt);
                const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
                cipher.setAAD(header);
                const file = await open(output, 'wx', 0o600);
                try {
                    await writeFully(file, header);
                }
                finally {
                    await file.close();
                }
                await pipeline(createReadStream(plain), cipher, createWriteStream(output, { flags: 'r+', start: 64 }));
                const final = await open(output, 'a');
                try {
                    await writeFully(final, cipher.getAuthTag());
                    await final.sync();
                }
                finally {
                    await final.close();
                }
                return output;
            }
            catch (error) {
                await rm(output, { force: true });
                throw error;
            }
            finally {
                key?.fill(0);
                await rm(stage, { recursive: true, force: true });
            }
        },
        async verify(path, passphrase) {
            const root = await privateDirectory(directory), stage = await mkdtemp(join(root, '.restore-')), plain = join(stage, 'authenticated.zip');
            let key: Buffer | undefined;
            try {
                const file = await open(path, 'r');
                let header: Buffer, tag: Buffer, size: number;
                try {
                    const info = await file.stat();
                    if (!info.isFile() || info.size < 80 || info.size > maximumArchiveBytes + 80)
                        throw failure();
                    header = Buffer.alloc(64);
                    await file.read(header, 0, 64, 0);
                    if (!header.subarray(0, 8).equals(magic) || header.readUInt32BE(8) !== 131072 || header.readUInt32BE(12) !== 8 || header.readUInt32BE(16) !== 1 || !header.subarray(56).equals(Buffer.alloc(8)))
                        throw failure();
                    size = Number(header.readBigUInt64BE(48));
                    if (size < 22 || size > maximumArchiveBytes || size + 80 !== info.size)
                        throw failure();
                    tag = Buffer.alloc(16);
                    await file.read(tag, 0, 16, 64 + size);
                }
                finally {
                    await file.close();
                }
                key = await keyFor(passphrase, header.subarray(20, 36));
                const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(36, 48), { authTagLength: 16 });
                decipher.setAAD(header);
                decipher.setAuthTag(tag);
                // No ZIP parser or extraction runs until final() has authenticated every byte.
                await pipeline(createReadStream(path, { start: 64, end: 64 + size - 1 }), decipher, bound(maximumArchiveBytes), createWriteStream(plain, { flags: 'wx', mode: 0o600 }));
                const entries = await extractVerified(plain, stage);
                await rm(plain);
                return { directory: stage, entries };
            }
            catch {
                await rm(stage, { recursive: true, force: true });
                throw failure();
            }
            finally {
                key?.fill(0);
            }
        }
    };
}
