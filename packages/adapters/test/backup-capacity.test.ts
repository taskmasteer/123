import { expect, it } from 'vitest';
import { ArchiveCapacity, ArchiveInventory, DiskRestoreEntries, maximumArchiveBytes } from '../src/backup-archive.js';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { validateRecovery } from '../src/recovery-records.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('streams a representative 5000-site six-state inventory without allocating its projected blobs', () => {
    const before = process.memoryUsage().heapUsed, inventory = new Map<string, {
        key: string;
        size: number;
        sha256: string;
    }>(), capacity = new ArchiveCapacity(), hash = 'a'.repeat(64);
    let ordinal = 0, record = 0;
    const add = (size: number) => { const id = ordinal++, key = 'private/artifacts/' + id; inventory.set(key, { key, size, sha256: hash }); capacity.add('payloads/' + id + '.bin', size, hash); capacity.add('records/' + record++ + '.json', 250, hash); };
    for (let site = 0; site < 5000; site++) {
        capacity.add('records/' + record++ + '.json', 300, hash);
        for (let state = 0; state < 6; state++) {
            for (let file = 0; file < 5; file++)
                add(10000);
            add(100000);
            add(100000);
            add(100000);
            add(100000);
            for (let row = 0; row < 7; row++)
                capacity.add('records/' + record++ + '.json', 650, hash);
        }
    }
    expect(inventory.size).toBe(270000);
    expect(capacity.metadataRecords).toBe(485000);
    expect(capacity.entries).toBe(755000);
    expect(capacity.bytes).toBeLessThan(maximumArchiveBytes);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(256 * 1024 ** 2);
    // Additional detailed checkpoint snapshots are a separate volume, not silently omitted.
    expect(() => { for (let i = 0; i < 10000; i++)
        capacity.add('payloads/' + (ordinal + i) + '.bin', 32 * 1024 ** 2, hash); }).toThrow();
});
it('indexes the actual representative755000 authenticated metadata/payload descriptors on bounded private disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archive-index-')), before = process.memoryUsage(), index = new ArchiveInventory(join(root, 'inventory.sqlite')), hash = 'a'.repeat(64);
    let peakHeap = before.heapUsed, peakRss = before.rss;
    try {
        for (let ordinal = 0; ordinal < 755000; ordinal++) {
            const name = ordinal < 485000 ? 'records/' + ordinal + '.json' : 'payloads/' + (ordinal - 485000) + '.bin', size = ordinal < 485000 ? 250 : 10000;
            index.name(name);
            index.add({ name, size, sha256: hash });
            if (ordinal % 10000 === 0) {
                const usage = process.memoryUsage();
                peakHeap = Math.max(peakHeap, usage.heapUsed);
                peakRss = Math.max(peakRss, usage.rss);
            }
        }
        expect(index.remaining()).toBe(755000);
        index.db.exec("create table entries as select row_number() over(order by name)-1 seq,name,size,sha256,'fixture-file' file from inventory;create unique index descriptor_seq on entries(seq);");
        index.db.exec('commit');
        const descriptors = new DiskRestoreEntries(join(root, 'inventory.sqlite'), 755000);
        let visited = 0;
        for (const entry of descriptors) {
            if (entry.size <= 0)
                throw new Error('Invalid descriptor size');
            if (++visited % 10000 === 0) {
                const usage = process.memoryUsage();
                peakHeap = Math.max(peakHeap, usage.heapUsed);
                peakRss = Math.max(peakRss, usage.rss);
            }
        }
        expect(visited).toBe(755000);
        expect(descriptors.at(754999)).toBeTruthy();
        expect(index.take('payloads/269999.bin')).toMatchObject({ size: 10000, sha256: hash });
        expect(() => index.name('records/0.json')).toThrow();
        expect(peakHeap - before.heapUsed).toBeLessThan(256 * 1024 ** 2);
        expect((await stat(join(root, 'inventory.sqlite'))).size).toBeGreaterThan(50000000);
        await writeFile('.local-state/task12-index-measured.json', JSON.stringify({ records: 755000, heapGrowth: peakHeap - before.heapUsed, rssGrowth: peakRss - before.rss }));
    }
    finally {
        index.close();
        await rm(root, { recursive: true, force: true });
    }
}, 60000);
it('validates5000 logical records through bounded disk descriptors and rejects missing closure without target writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'logical-index-')), header = join(root, 'header'), row = join(root, 'row'), value = JSON.stringify({ type: 'row', table: 'public.users', row: { id: 'fixture' } }), h = JSON.stringify({ type: 'header', version: 1, schema: 8, adapter: 'managed', sourceId: 'fixture', createdAt: 1 });
    await writeFile(header, h);
    await writeFile(row, value);
    const entry = (n: number) => ({ name: 'records/' + n + '.json', size: Buffer.byteLength(n ? value : h), sha256: 'a'.repeat(64), file: n ? row : header }), entries = { length: 5001, at: entry, *[Symbol.iterator]() { for (let n = 0; n < 5001; n++)
            yield entry(n); } };
    try {
        const result = await validateRecovery(entries, 'managed');
        expect(result.rows.length).toBe(5001);
        let read = 0;
        for (const r of result.rows)
            read++;
        expect(read).toBe(5001);
        await expect(validateRecovery(entries, 'local')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}, 60000);
