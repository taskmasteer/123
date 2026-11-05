import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { crc32, deflateSync } from 'node:zlib';
import { openLocalDatabase } from '../src/local-database.js';
import { LocalBatches } from '../src/local-batches.js';
import { LocalImportResources, decodeLogo } from '../src/import-resources.js';
const owner = { userId: 'owner', role: 'user' } as const;
it('stages bounded hashed chunks, edits one about, maps a local logo, and keeps invalid rows after commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-resource-')), db = await openLocalDatabase(root), b = new LocalBatches(db), resources = new LocalImportResources(b);
    const call = (m: string, p: any): Promise<any> => resources.request(owner, m, p);
    const upload = async (name: string, bytes: Buffer, extra: any = {}) => { const r = await call('resource.begin', { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...extra }); expect(r.id).toMatch(/^[a-f0-9-]{36}$/); await call('resource.chunk', { id: r.id, index: 0, base64: bytes.toString('base64') }); return r.id; };
    try {
        const id = await upload('sites.csv', Buffer.from('domain,about,logo,mentionedUrl\na.test,First,logo.png,https://example.com\nb.test,Second,,https://example.com\n,Invalid,,https://example.com\n'));
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
function pngChunk(type: string, data: Buffer) {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 'ascii');
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
}
it('rejects a tiny duplicate IHDR before the decoder can replace its checked dimensions', () => {
    const small = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const large = PNG.sync.write(new PNG({ width: 2049, height: 1 }));
    const attack = Buffer.concat([small.subarray(0, 33), large.subarray(8)]);
    expect(attack.length).toBe(112);
    expect(PNG.sync.read(attack).width).toBe(2049);
    const read = vi.spyOn(PNG.sync, 'read');
    try {
        expect(() => decodeLogo(attack)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(read).not.toHaveBeenCalled();
    }
    finally {
        read.mockRestore();
    }
});
it('rejects malformed IHDR and excess interlaced inflation before calling pngjs', () => {
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const header = Buffer.from(png.subarray(16, 29));
    header[12] = 1;
    const bomb = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(4096))), pngChunk('IEND', Buffer.alloc(0))]);
    const malformed = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header.subarray(0, 12)), png.subarray(33)]);
    const badCrc = Buffer.from(png);
    badCrc[29] = badCrc[29]! ^ 1;
    const read = vi.spyOn(PNG.sync, 'read');
    try {
        for (const bytes of [bomb, malformed, badCrc]) {
            expect(() => decodeLogo(bytes)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
            expect(read).not.toHaveBeenCalled();
        }
    }
    finally {
        read.mockRestore();
    }
});
it('accepts legal Adam7 passes, RGBA16 scanlines and the maximum supported width', () => {
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    for (const [width, height, depth, interlace, scanlineBytes] of [[1, 1, 8, 1, 5], [8, 8, 8, 1, 271], [1, 1, 16, 0, 9], [2048, 1, 8, 0, 8193]]) {
        const header = Buffer.from(png.subarray(16, 29));
        header.writeUInt32BE(width!, 0);
        header.writeUInt32BE(height!, 4);
        header[8] = depth!;
        header[12] = interlace!;
        const bytes = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(scanlineBytes!))), pngChunk('IEND', Buffer.alloc(0))]);
        expect(decodeLogo(bytes).bytes).toEqual(new Uint8Array(bytes));
        expect(PNG.sync.read(bytes)).toMatchObject({ width, height });
    }
});

it('overlapping prepare cannot rewind a batch committed after the first preview', async () => {
 const root = await mkdtemp(join(tmpdir(), 'sf-prepare-race-')), db = await openLocalDatabase(root), b = new LocalBatches(db), service = new LocalImportResources(b);
 const bytes=Buffer.from('domain,about,mentionedUrl\na.test,First,https://example.com\n'), call=(m:string,p:unknown)=>service.request(owner,m,p) as Promise<any>;
 let releaseA!:()=>void,releaseB!:()=>void,entered=0; const original=setImmediate;
 try {
  const {id}=await call('resource.begin',{name:'race.csv',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  await call('resource.chunk',{id,index:0,base64:bytes.toString('base64')});
  const spy=vi.spyOn(globalThis,'setImmediate').mockImplementation(((callback:()=>void)=>{ entered++; if(entered===1)releaseA=callback;else releaseB=callback;return {} as any;}) as typeof setImmediate);
  const a=call('import.prepare',{id}), c=call('import.prepare',{id});
  while(entered<2)await new Promise<void>(r=>original(r));
  spy.mockRestore(); releaseA(); const preview=await a;
  await call('import.commit',{id,revision:preview.revision,requestKey:'race-commit'});
  releaseB(); expect(await c).toMatchObject({state:'active'});
  expect(await b.get(owner,id)).toMatchObject({state:'active'});
  expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(1);
 } finally { vi.restoreAllMocks();await db.close();await rm(root,{recursive:true,force:true}); }
});
