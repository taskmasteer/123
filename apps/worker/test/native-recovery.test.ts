import { expect, it, afterEach } from 'vitest';
import { resolve, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { activeLocalRoot } from '../src/local-root.js';
import { directory, cleanDirectories } from './fixtures.js';
afterEach(cleanDirectories);
it('keeps passphrase/archive paths off ordinary dispatch and installs a verified fresh local root through the private native port', async () => {
    const root = await directory(), runtime = await createDesktopRuntime(root, resolve('.'), { native: true }), request = (method: string, params: unknown = {}): Promise<any> => runtime.request({ id: 'native-recovery', version: 1, method, params });
    async function completed(id: string) { let result: any; await expect.poll(async () => { result = await runtime.archive({ action: 'status', id }); return result.state === 'failed' ? 'failed' : result.state; }, { timeout: 15000 }).toMatch(/^(ready|failed)$/); if (result.state === 'failed')
        throw new Error(result.error); return result.result; }
    try {
        await runtime.configure({ mode: 'demo' });
        const created = await request('site.create', { domain: 'native-copy.test' });
        await expect.poll(async () => (await request('job.status', { siteId: created.site.id })).state, { timeout: 20000 }).toBe('completed');
        const published = (await request('site.list')).items[0].publishedId;
        expect(published).toBeTruthy();
        await expect(request('backup.create', { passphrase: 'private recovery test' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        const operation = await runtime.archive({ action: 'backup', passphrase: 'private recovery test' }) as {
            id: string;
        }, saved = await completed(operation.id);
        expect(saved.handle).toMatchObject({ id: operation.id, kind: 'backup' });
        expect(JSON.stringify(saved)).not.toContain(root);
        expect(JSON.stringify(saved)).not.toContain('private recovery test');
        const files = (await readdir(join(root, '.exports'))).filter(p => p.endsWith('.sfbak'));
        expect(files).toHaveLength(1);
        const inspected = await runtime.archive({ action: 'inspect', passphrase: 'private recovery test', archivePath: join(root, '.exports', files[0]!) }) as {
            id: string;
        };
        expect((await completed(inspected.id)).adapter).toBe('local');
        const restore = await runtime.archive({ action: 'restore', id: inspected.id, mappings: [] }) as {
            id: string;
        }, report = await completed(restore.id);
        expect(report).toMatchObject({ restoredSites: 1, quarantined: true, restartRequired: true });
        const selected = await activeLocalRoot(root, resolve('.'));
        expect(selected.root).toContain('.restored');
        expect(selected.sourceRoot).toBe(join(selected.root, '.catalog'));
        expect(JSON.parse(await readFile(join(root, '.active-root.json'), 'utf8')).id).toBe(report.targetId);
        const recovered = await createDesktopRuntime(selected.root, selected.sourceRoot, { native: true, baseRoot: root });
        try {
            expect((await recovered.request({ id: 'status', version: 1, method: 'recovery.status', params: {} }) as any).quarantined).toBe(true);
            const sites = await recovered.request({ id: 'list', version: 1, method: 'site.list', params: {} }) as any;
            expect(sites.items[0].publishedId).toBe(published);
            await recovered.configure({ mode: 'demo' });
            expect((await recovered.request({ id: 'job', version: 1, method: 'job.status', params: { siteId: created.site.id } }) as any).state).toBe('completed');
        }
        finally {
            await recovered.close();
        }
    }
    finally {
        await runtime.close();
    }
}, 45000);
