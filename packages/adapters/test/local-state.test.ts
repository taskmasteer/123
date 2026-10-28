import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalState } from '../src/local-state.js';
import type { LocalState } from '../src/local-state.js';
import { openLocalDatabase } from '../src/local-database.js';
import { ManualClock } from '../../testing/src/clock.js';
const owner = { userId: 'owner', role: 'user' } as const;
const admin = { userId: 'admin', role: 'admin' } as const;
const clock = { now: () => 1800000000000 };
const directories: string[] = [];
const opened: LocalState[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'site-factory-')); directories.push(dir); return dir; }
async function open(dir: string) { const state = await createLocalState(dir, clock); opened.push(state); return state; }
afterEach(async () => {
    await Promise.all(opened.splice(0).map((state) => state.close()));
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('local registry', () => {
    // Catches memory-only writes, default record loss, or inconsistent canonical fields.
    it('persists a normalized site across close and reopen', async () => {
        const dir = await directory();
        const first = await open(dir);
        const site = await first.create({ domain: ' HTTPS://EXAMPLE.COM/ ', about: 'Cloud tools' }, owner);
        expect(site).toMatchObject({ domain: 'example.com', ownerId: 'owner', revision: 0, input: { domain: 'example.com', about: 'Cloud tools' } });
        expect(site.id).toMatch(/^[0-9a-f-]{36}$/);
        await first.close();
        const reopened = await open(dir);
        expect(await reopened.get(site.id)).toEqual(site);
    });
    // Catches a non-atomic uniqueness check during simultaneous writes.
    it('rejects concurrent canonical duplicates without overwriting a site', async () => {
        const state = await open(await directory());
        const results = await Promise.allSettled([
            state.create({ domain: 'EXAMPLE.COM' }, owner), state.create({ domain: 'https://example.com/' }, admin),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'DUPLICATE_DOMAIN' } });
        expect((await state.list(admin)).items).toHaveLength(1);
    });
    // Catches blind overwrites and lost updates; revision is a compare-and-set token.
    it('allows only one writer for an expected revision and persists the winning draft', async () => {
        const dir = await directory();
        const state = await open(dir);
        const site = await state.create({ domain: 'example.com' }, owner);
        const results = await Promise.allSettled([
            state.compareAndSet(site.id, 0, { draftId: 'draft-a' }),
            state.compareAndSet(site.id, 0, { draftId: 'draft-b' }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
        await state.close();
        const reopened = await open(dir);
        expect(await reopened.get(site.id)).toMatchObject({ revision: 1, draftId: 'draft-a' });
        await expect(reopened.compareAndSet('missing', 0, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
    // Catches unscoped lists or pagination that skips visible items.
    it('paginates only owned and assigned sites while admin sees all', async () => {
        const state = await open(await directory());
        const first = await state.create({ domain: 'first.com' }, owner);
        const hidden = await state.create({ domain: 'hidden.com' }, admin);
        const assigned = await state.create({ domain: 'assigned.com' }, admin);
        await state.compareAndSet(assigned.id, 0, { assignedUserIds: ['owner'] });
        const page = await state.list(owner, undefined, 1);
        expect(page.items.map((site) => site.id)).toEqual([first.id]);
        expect(page.nextCursor).not.toBeNull();
        const next = await state.list(owner, page.nextCursor!, 1);
        expect(next.items.map((site) => site.id)).toEqual([assigned.id]);
        expect(next.nextCursor).toBeNull();
        expect((await state.list(admin)).items.map((site) => site.id)).toEqual([first.id, hidden.id, assigned.id]);
        expect(await state.get('missing')).toBeNull();
        await expect(state.list(owner, undefined, 0)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(state.list(owner, 'bad-cursor')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
    // Catches leaked references that can mutate durable state outside the mutex.
    it('returns isolated snapshots for reads and writes', async () => {
        const state = await open(await directory());
        const input = { domain: 'example.com', about: 'Original' };
        const site = await state.create(input, owner);
        input.about = 'Changed';
        site.assignedUserIds.push('stranger');
        const read = (await state.get(site.id))!;
        read.input.about = 'Changed again';
        expect(await state.get(site.id)).toMatchObject({ input: { about: 'Original' }, assignedUserIds: [] });
    });
    // Catches permissive loading and catastrophic replacement of corrupt state.
    it.each(['{broken', '{"version":1,"savedAt":123,"sites":[{"id":"partial"}]}'])('refuses corrupt state without replacing it: %s', async (contents) => {
        const dir = await directory();
        const path = join(dir, 'state.json');
        await writeFile(path, contents);
        await expect(createLocalState(dir, clock)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(await readFile(path, 'utf8')).toBe(contents);
    });
    // Catches closing during pending writes or accidental reuse of a stale handle.
    it('flushes in-flight writes before closing and rejects future use', async () => {
        const dir = await directory();
        const state = await open(dir);
        const pending = state.create({ domain: 'example.com' }, owner);
        await state.close();
        const site = await pending;
        await expect(state.create({ domain: 'other.com' }, owner)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await (await open(dir)).get(site.id)).toMatchObject({ domain: 'example.com' });
    });
    it('is unavailable in production', async () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            await expect(createLocalState(await directory(), clock)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
        finally {
            if (previous === undefined)
                delete process.env.NODE_ENV;
            else
                process.env.NODE_ENV = previous;
        }
    });
    // Catches repeated close accidentally releasing the lock belonging to a reopened handle.
    it('keeps the reopened registry locked when the old handle is closed again', async () => {
        const dir = await directory();
        const first = await open(dir);
        await expect(createLocalState(dir, clock)).rejects.toMatchObject({ code: 'CONFLICT' });
        await first.close();
        await open(dir);
        await first.close();
        await expect(createLocalState(dir, clock)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    // Catches incorrect clock wiring and timestamp reuse on subsequent writes.
    it('persists the injected clock time for each SQL commit', async () => {
        const dir = await directory(), db = await openLocalDatabase(dir), manualClock = new ManualClock(1000);
        const state = await createLocalState(dir, manualClock, db);
        opened.push(state);
        try {
            const site = await state.create({ domain: 'example.com' }, owner);
            expect(db.sql.prepare('select value from metadata where key=?').get('savedAt')!.value).toBe('1000');
            manualClock.advanceBy(250);
            await state.compareAndSet(site.id, 0, { generationStatus: 'running' });
            expect(db.sql.prepare('select value from metadata where key=?').get('savedAt')!.value).toBe('1250');
        }
        finally {
            await state.close();
            await db.close();
        }
    });
    it('rolls back failed SQL writes and accepts a later valid CAS', async () => {
        const dir = await directory(), db = await openLocalDatabase(dir), state = await createLocalState(dir, clock, db);
        opened.push(state);
        try {
            const site = await state.create({ domain: 'example.com' }, owner);
            db.sql.exec("create trigger reject_site before update on sites begin select raise(abort,'fixture write failed');end");
            await expect(state.compareAndSet(site.id, 0, { draftId: 'failed-draft' })).rejects.toThrow('fixture write failed');
            expect(await state.get(site.id)).toMatchObject({ revision: 0, draftId: null });
            db.sql.exec('drop trigger reject_site');
            await state.compareAndSet(site.id, 0, { draftId: 'recovered-draft' });
            expect(await state.get(site.id)).toMatchObject({ revision: 1, draftId: 'recovered-draft' });
        }
        finally {
            await state.close();
            await db.close();
        }
    });
});
