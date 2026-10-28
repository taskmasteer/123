import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, open, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createCipheriv, scryptSync } from 'node:crypto';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeZip, writeFully, portableArchive } from '../src/backup-archive.js';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it('writes partial buffers fully and removes interrupted/hash-mismatched ZIPs', async () => {
    const parts: number[] = [];
    await writeFully({ write: async (bytes: Uint8Array, offset: number) => { parts.push(bytes[offset]!); return { bytesWritten: 1 }; } } as any, Buffer.from([1, 2, 3]));
    expect(parts).toEqual([1, 2, 3]);
    const root = await mkdtemp(join(tmpdir(), 'zip-abort-'));
    try {
        const file = join(root, 'bad.zip');
        await expect(writeZip(file, (async function* () { yield { name: 'index.html', size: 1, sha256: hash(Buffer.from('a')), read: async () => Buffer.from('b') }; })())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(await readdir(root)).toEqual([]);
        await expect(writeZip(file, (async function* () { yield { name: 'index.html', size: 0, sha256: hash(Buffer.alloc(0)), read: async () => Buffer.alloc(0) }; throw new Error('aborted'); })())).rejects.toThrow('aborted');
        expect(await readdir(root)).toEqual([]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
it('interoperates with a standard ZIP reader across65535 entries with correct CRC/ZIP64 offsets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zip64-')), path = join(root, 'standard.zip'), bytes = Buffer.from('standard original bytes'), sha256 = hash(bytes), before = process.memoryUsage();
    try {
        await writeZip(path, (async function* () { for (let i = 0; i < 65537; i++)
            yield { name: 'files/' + i + '.html', size: bytes.length, sha256, read: async () => bytes }; })());
        const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true }, (e, z) => e || !z ? reject(e) : resolve(z)));
        let count = 0;
        await new Promise<void>((resolve, reject) => { zip.on('error', reject); zip.on('entry', entry => { expect(entry.fileName).toBe('files/' + count + '.html'); expect(entry.crc32).toBe(crc32(bytes)); count++; zip.readEntry(); }); zip.on('end', resolve); zip.readEntry(); });
        expect(count).toBe(65537);
        const file = await open(path), tail = Buffer.alloc(98);
        try {
            await file.read(tail, 0, 98, (await file.stat()).size - 98);
            expect(tail.readUInt32LE(0)).toBe(0x06064b50);
            expect(tail.readBigUInt64LE(32)).toBe(65537n);
            expect(tail.readUInt32LE(56)).toBe(0x07064b50);
        }
        finally {
            await file.close();
        }
        if (process.platform === 'win32') {
            const command = "Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[System.IO.Compression.ZipFile]::OpenRead('" + path.replaceAll("'", "''") + "'); try { $archive.Entries.Count; $reader=[IO.StreamReader]::new($archive.Entries[65536].Open()); try {$reader.ReadToEnd()} finally {$reader.Dispose()} } finally {$archive.Dispose()}";
            const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
            expect(result.stdout.replace(/\r/g, '').trim()).toBe('65537\nstandard original bytes');
        }
        await writeFile('.local-state/task12-zip64-measured.json', JSON.stringify({ entries: count, bytes: (await stat(path)).size, heapGrowth: process.memoryUsage().heapUsed - before.heapUsed, rssGrowth: process.memoryUsage().rss - before.rss }));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}, 60000);
function encrypted(zip: Buffer) { const header = Buffer.alloc(64); header.write('SFBAK001'); header.writeUInt32BE(131072, 8); header.writeUInt32BE(8, 12); header.writeUInt32BE(1, 16); Buffer.alloc(16, 1).copy(header, 20); Buffer.alloc(12, 2).copy(header, 36); header.writeBigUInt64BE(BigInt(zip.length), 48); const key = scryptSync('secret test pass', header.subarray(20, 36), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 ** 2 }), cipher = createCipheriv('aes-256-gcm', key, header.subarray(36, 48)); cipher.setAAD(header); const body = Buffer.concat([cipher.update(zip), cipher.final()]); key.fill(0); return Buffer.concat([header, body, cipher.getAuthTag()]); }
it('rejects authenticated malicious ZIP paths, symlinks, compression, CRC mismatch and truncation before extraction succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zip-hostile-')), plain = join(root, 'plain.zip');
    try {
        const bytes = Buffer.from('body');
        await writeZip(plain, (async function* () { yield { name: 'payloads/0.bin', size: bytes.length, sha256: hash(bytes), read: async () => bytes }; })(), join(root, 'index'));
        const original = await readFile(plain), cd = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        const changes = [(b: Buffer) => b.writeUInt16LE(8, cd + 10), (b: Buffer) => b.writeUInt32LE((0o120777 << 16) >>> 0, cd + 38), (b: Buffer) => b.writeUInt32LE(123, cd + 16), (b: Buffer) => b.write('../bad/00.bin', cd + 46), (b: Buffer) => b.subarray(0, b.length - 1)];
        for (const [i, change] of changes.entries()) {
            const copy = Buffer.from(original), result = change(copy), zip = Buffer.isBuffer(result) ? result : copy, path = join(root, 'hostile' + i + '.sfbak');
            await writeFile(path, encrypted(zip));
            await expect(portableArchive(join(root, 'verify')).verify(path, 'secret test pass')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
            expect((await readdir(join(root, 'verify'))).filter(n => n.startsWith('.restore-'))).toEqual([]);
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}, 15000);
async function indexedFixture(root: string, files: {
    name: string;
    bytes: Buffer;
}[], index: any[]) { const path = join(root, 'fixture-' + Math.random() + '.zip'), all = [...files, { name: 'indexes/0.ndjson', bytes: Buffer.from(index.map(v => JSON.stringify(v) + '\n').join('')) }], aliases = all.map(f => ({ actual: f.name, safe: f.name.startsWith('records/') ? f.name.replace('.json', '.html') : f.name.startsWith('payloads/') ? f.name.replace('.bin', '.css') : 'indexes/0.a.html', bytes: f.bytes })); await writeZip(path, (async function* () { for (const f of aliases)
    yield { name: f.safe, size: f.bytes.length, sha256: hash(f.bytes), read: async () => f.bytes }; })()); const bytes = await readFile(path); for (const f of aliases) {
    const from = Buffer.from(f.safe), to = Buffer.from(f.actual);
    expect(from.length).toBe(to.length);
    let start = 0;
    while (true) {
        const offset = bytes.indexOf(from, start);
        if (offset < 0)
            break;
        to.copy(bytes, offset);
        start = offset + from.length;
    }
} return bytes; }
it('reads old explicit file records and new authenticated embedded descriptors while rejecting malformed duplicate mixed and unmatched forms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'embedded-descriptor-')), body = Buffer.from('<h1>Original payload</h1>'), payload = { name: 'payloads/0.bin', size: body.length, sha256: hash(body) }, file = { recordName: 'records/0.json', root: 'data', path: 'artifacts/manifests/11111111-1111-4111-8111-111111111111/0.bin', mediaType: 'text/html' }, logical = Buffer.from(JSON.stringify({ type: 'file', root: file.root, path: file.path, payload: payload.name, size: payload.size, sha256: payload.sha256, mediaType: file.mediaType })), record = { name: file.recordName, size: logical.length, sha256: hash(logical) };
    let ordinal = 0;
    const verify = async (zip: Buffer) => { const path = join(root, 'case' + ordinal++ + '.sfbak'); await writeFile(path, encrypted(zip)); return portableArchive(join(root, 'verified')).verify(path, 'secret test pass'); };
    try {
        const old = await verify(await indexedFixture(root, [{ name: record.name, bytes: logical }, { name: payload.name, bytes: body }], [record, payload]));
        expect(old.entries.length).toBe(2);
        await rm(old.directory, { recursive: true, force: true });
        const plain = join(root, 'new.zip');
        await writeZip(plain, (async function* () { yield { ...record, read: async () => logical }; yield { ...payload, read: async () => body }; })(), join(root, 'new-index'));
        const current = await verify(await readFile(plain));
        expect(current.entries.length).toBe(2);
        let metadata;
        for (const entry of current.entries)
            if (entry.name === record.name)
                metadata = JSON.parse((await readFile(entry.file)).toString());
        expect(metadata).toEqual(JSON.parse(logical.toString()));
        await rm(current.directory, { recursive: true, force: true });
        const malformed = [null, { ...file, root: 'any' }, { ...file, path: '../secret' }, { ...file, mediaType: 'image/png\nheader' }, { ...file, recordName: 'records/1000000.json' }, { ...file, extra: true }];
        for (const descriptor of malformed)
            await expect(verify(await indexedFixture(root, [{ name: payload.name, bytes: body }], [{ ...payload, fileDescriptorV1: descriptor }]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(verify(await indexedFixture(root, [{ name: payload.name, bytes: body }], [{ ...payload, fileDescriptorV2: file }]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(verify(await indexedFixture(root, [{ name: record.name, bytes: logical }, { name: payload.name, bytes: body }], [record, { ...payload, fileDescriptorV1: file }]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const another = { ...payload, name: 'payloads/1.bin' };
        await expect(verify(await indexedFixture(root, [{ name: payload.name, bytes: body }, { name: another.name, bytes: body }], [{ ...payload, fileDescriptorV1: file }, { ...another, fileDescriptorV1: file }]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(verify(await indexedFixture(root, [{ name: record.name, bytes: logical }], [record]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}, 30000);
