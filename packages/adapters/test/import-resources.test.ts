import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { openLocalDatabase } from '../src/local-database.js';
import { LocalBatches } from '../src/local-batches.js';
import { LocalImportResources } from '../src/import-resources.js';
const owner = { userId: 'owner', role: 'user' } as const;
it('stages bounded hashed chunks, edits one about, maps a local logo, and keeps invalid rows after commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-resource-')), db = await openLocalDatabase(root), b = new LocalBatches(db), resources = new LocalImportResources(b);
    const call = (m: string, p: any): Promise<any> => resources.request(owner, m, p);
    const upload = async (name: string, bytes: Buffer, extra: any = {}) => { const r = await call('resource.begin', { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...extra }); expect(r.id).toMatch(/^[a-f0-9-]{36}$/); await call('resource.chunk', { id: r.id, index: 0, base64: bytes.toString('base64') }); return r.id; };
    try {
        const id = await upload('sites.csv', Buffer.from('domain,about,logo\na.test,First,logo.png\nb.test,Second,\n,Invalid,\n'));
        let summary = await call('import.prepare', { id });
        expect(summary).toMatchObject({ validCount: 1, invalidCount: 2, total: 3 });
        summary = await call('import.update', { id, revision: summary.revision, rowNumber: 3, about: 'Changed only second' });
        expect((await b.page(owner, id)).items.map(r => r.input.about)).toEqual(['First', 'Changed only second', 'Invalid']);
        const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
        const logo = await upload('logo.png', png, { draftId: id, rowNumber: 2, revision: summary.revision });
        summary = await call('logo.complete', { id: logo });
        expect(summary.validCount).toBe(2);
        const committed = await call('import.commit', { id, revision: summary.revision, requestKey: 'submit' });
        expect(committed).toEqual({ batchId: id });
        expect((await b.page(owner, id)).items[2]!.issues).not.toHaveLength(0);
        expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(2);
        expect(await call('import.commit', { id, revision: summary.revision, requestKey: 'submit' })).toEqual(committed);
        await expect(resources.request({ userId: 'other', role: 'user' }, 'resource.chunk', { id: logo, index: 0, base64: png.toString('base64') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('keeps worst multibyte invalid preview cells intact inside a bounded serialized page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-page-bytes-')), db = await openLocalDatabase(root), b = new LocalBatches(db), service = new LocalImportResources(b);
    try {
        const cell = '中'.repeat(8000), source = Buffer.from('domain,about,referenceId,logo\n' + Array.from({ length: 5 }, () => [cell, cell, cell, cell].join(',')).join('\n')), r = await service.request(owner, 'resource.begin', { name: 'bytes.csv', size: source.length, sha256: createHash('sha256').update(source).digest('hex') }) as {
            id: string;
        };
        for (let offset = 0; offset < source.length; offset += 24000)
            await service.request(owner, 'resource.chunk', { id: r.id, index: offset / 24000, base64: source.subarray(offset, offset + 24000).toString('base64') });
        await service.request(owner, 'import.prepare', { id: r.id });
        const page = await b.page(owner, r.id);
        expect(page.items).toHaveLength(5);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1000000);
        expect(page.items.every(r => r.input.about === cell && r.input.domain === cell)).toBe(true);
    }
    finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
