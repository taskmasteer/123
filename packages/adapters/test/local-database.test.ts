import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalDatabase } from '../src/local-database.js';
import { createLocalState } from '../src/local-state.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
it('migrates validated legacy records, reopens atomically and preserves original bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-db-'));
    await mkdir(join(root, 'sites'));
    const legacy = JSON.stringify({ version: 1, savedAt: 123, sites: [{ id: 'legacy', domain: 'a.test', ownerId: 'owner', assignedUserIds: [], input: { domain: 'a.test' }, revision: 0, draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'pending' }] });
    await writeFile(join(root, 'sites/state.json'), legacy);
    try {
        const db = await openLocalDatabase(root);
        expect(db.sql.prepare('select id from sites').all()).toEqual([{ id: 'legacy' }]);
        await db.close();
        const next = await openLocalDatabase(root);
        expect(next.sql.prepare('select id from sites').all()).toHaveLength(1);
        expect(await readFile(join(root, 'sites/state.json'), 'utf8')).toBe(legacy);
        await next.close();
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
it.skipIf(process.env.SITE_FACTORY_LARGE_LEGACY_MIGRATION !== '1')('migrates a formerly legal registry larger than64MiB and retains the original byte hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-large-legacy-'));
    const about = '中'.repeat(8000), sites = Array.from({ length: 3000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, domain: `legacy-${i}.test`, ownerId: 'owner', assignedUserIds: [], input: { domain: `legacy-${i}.test`, about }, revision: 0, draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'pending' }));
    const source = JSON.stringify({ version: 1, savedAt: 123, sites }), before = createHash('sha256').update(source).digest('hex'), size = Buffer.byteLength(source);
    expect(size).toBeGreaterThan(64 * 1024 * 1024);
    await writeFile(join(root, 'state.json'), source);
    let db: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
    try {
        const start = performance.now();
        db = await openLocalDatabase(root);
        expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(3000);
        await db.close();
        db = await openLocalDatabase(root);
        expect(db.sql.prepare('select count(*) n from sites').get()!.n).toBe(3000);
        const after = createHash('sha256');
        for await (const chunk of createReadStream(join(root, 'state.json')))
            after.update(chunk);
        expect(after.digest('hex')).toBe(before);
        await writeFile('.local-state/task-10-large-legacy-measurement.json', JSON.stringify({ records: 3000, sourceBytes: size, migrateAndReopenMs: performance.now() - start, originalSha256: before }));
    }
    finally {
        await db?.close();
        await rm(root, { recursive: true, force: true });
    }
}, 120000);
it('rejects structurally valid SQLite with a malformed nested site rather than overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-db-corrupt-')), db = await openLocalDatabase(root), state = await createLocalState(root, { now: () => 123 }, db);
    try {
        await state.create({ domain: 'safe.test' }, { userId: 'owner', role: 'user' });
        db.sql.prepare('update sites set data=?').run('{"id":"partial"}');
        await state.close();
        await db.close();
        await expect(openLocalDatabase(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    finally {
        await state.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
it('rejects competing controllers and junction aliases; corrupt nested migration never replaces originals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sf-owner-')), alias = root + '-alias';
    try {
        const db = await openLocalDatabase(root);
        await expect(openLocalDatabase(root)).rejects.toMatchObject({ code: 'CONFLICT' });
        await symlink(root, alias, 'junction');
        await expect(openLocalDatabase(alias)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await db.close();
        await rm(alias);
        await writeFile(join(root, 'queue.json'), JSON.stringify({ version: 1, entries: [{ job: { id: 'bad' } }] }));
        await expect(openLocalDatabase(root)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(await readFile(join(root, 'queue.json'), 'utf8')).toContain('bad');
    }
    finally {
        await rm(alias, { force: true });
        await rm(root, { recursive: true, force: true });
    }
});
