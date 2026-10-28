import { test, expect } from './fixture.js';
test('shows real history/source and uses only the dedicated native archive channel with a cleared transient passphrase', async ({ page, workerBridge }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Создать сайт', exact: true }).click();
    await page.getByLabel('Домен', { exact: true }).fill('recovery-ui.test');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(page.getByText('Локальная версия готова', { exact: true })).toBeVisible({ timeout: 30000 });
    await page.getByRole('button', { name: 'Правки recovery-ui.test' }).click();
    await expect(page.getByRole('heading', { name: 'История публикаций' })).toBeVisible();
    await expect(page.getByText('Текущая публикация', { exact: true })).toBeVisible();
    await page.locator('.version-history').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local-state/task12-history-viewport.png' });
    await page.getByRole('button', { name: 'Исходники текущей версии' }).click();
    await expect(page.getByRole('heading', { name: 'Исходные файлы' })).toBeVisible();
    await page.getByRole('list', { name: 'Дерево файлов' }).getByRole('button').filter({ hasText: 'index.html' }).click();
    await expect(page.locator('.source-content pre')).toContainText('<!doctype html>');
    expect(await page.locator('.source-files iframe,.source-files script').count()).toBe(0);
    await page.locator('.source-files').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local-state/task12-source-viewport.png' });
    await page.evaluate(() => { const windowWithNative = window as unknown as {
        __TAURI_INTERNALS__: {
            invoke: (command: string, args: {
                request: any;
            }) => Promise<unknown>;
        };
        __archiveActions: string[];
    }; const original = windowWithNative.__TAURI_INTERNALS__.invoke; windowWithNative.__archiveActions = []; windowWithNative.__TAURI_INTERNALS__.invoke = async (command, args) => { if (command !== 'archive_operation')
        return original(command, args); const p = args.request; windowWithNative.__archiveActions.push(p.action); if (p.action === 'backup') {
        if (p.passphrase !== 'test portable secret')
            throw new Error('invalid test-only passphrase');
        if (Object.keys(p).sort().join(',') !== 'action,passphrase')
            throw new Error('unexpected native fields');
        return { id: '77777777-7777-4777-8777-777777777777' };
    } if (p.action === 'status')
        return { id: p.id, state: 'ready', result: { handle: { id: p.id, kind: 'backup', size: 12345, sha256: 'a'.repeat(64), expiresAt: Date.now() + 60000 } } }; if (['save', 'close'].includes(p.action))
        return { ok: true }; throw new Error('unexpected archive action'); }; });
    await page.getByRole('button', { name: 'Резервные копии', exact: true }).click();
    await page.getByLabel('Пароль копии', { exact: true }).fill('test portable secret');
    await page.getByRole('button', { name: 'Создать копию', exact: true }).click();
    await expect(page.getByLabel('Пароль копии', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Сохранить файл…' })).toBeVisible();
    await expect(page.getByText('SHA-256: ' + 'a'.repeat(64))).toBeVisible();
    await page.screenshot({ path: '.local-state/task12-backup-viewport.png' });
    await page.getByRole('button', { name: 'Сохранить файл…' }).click();
    await expect(page.getByText('Копия сохранена в выбранном месте.', { exact: true })).toBeVisible();
    expect(JSON.stringify(workerBridge.requests)).not.toContain('test portable secret');
    expect(await page.evaluate(() => (window as unknown as {
        __archiveActions: string[];
    }).__archiveActions)).toEqual(['backup', 'status', 'save', 'close']);
    await page.setViewportSize({ width: 1040, height: 680 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('managed recovery keeps ambiguous effects quarantined and enables release only after server reconciliation', async ({ page }) => {
    const user = '11111111-1111-4111-8111-111111111111', restoreId = '22222222-2222-4222-8222-222222222222', id = '33333333-3333-4333-8333-333333333333', jwt = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
    let resolved = false, positive = false;
    const bodies: any[] = [];
    await page.route('https://fixture.supabase.co/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: jwt, refresh_token: 'fixture', expires_in: 3600, token_type: 'bearer', user: { id: user, email: 'admin@example.test', aud: 'authenticated' } }) }));
    await page.route('https://control.example/**', route => { const req = route.request(), path = new URL(req.url()).pathname; let result: unknown; if (path === '/session')
        result = { principal: { userId: user, role: 'admin' }, mode: 'managed', capabilities: { admin: true, edit: true, generation: true, publish: true, export: false, preview: true, nativeModelSettings: false } };
    else if (path === '/sites')
        result = { items: [], nextCursor: null };
    else if (path === '/catalog')
        result = { styles: [], references: [] };
    else if (path === '/admin/recovery/status')
        result = { quarantined: true };
    else if (path === '/admin/recovery/publications')
        result = { restoreId, items: resolved ? [] : [{ id, siteId: user, domain: 'unknown-publication.example', accountId: 'team_fixture', attached: true, digest: 'a'.repeat(64) }], nextOffset: null, remaining: resolved ? 0 : 1 };
    else if (path === '/admin/recovery/reconcile') {
        const body = req.postDataJSON();
        bodies.push(body);
        expect(body).toEqual({ restoreId, id, digest: 'a'.repeat(64), retiredSourceAuthority: true });
        resolved = positive;
        result = positive ? { status: 'settled' } : { status: 'manual-required', reason: 'ambiguous-deployments' };
    }
    else if (path === '/admin/recovery/release') {
        expect(resolved).toBe(true);
        result = { ok: true };
    }
    else
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fixture' }, requestId: 'fixture' }) }); return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' }, body: JSON.stringify(result) }); });
    await page.goto('/');
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await page.getByLabel('Адрес общего API').fill('https://control.example');
    await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co');
    await page.getByLabel('Publishable key').fill('sb_publishable_fixture');
    await page.getByLabel('Email', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('fixture-only-password');
    await page.getByRole('button', { name: 'Войти в общий реестр' }).click();
    await page.getByRole('button', { name: 'Резервные копии', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Сверка внешних публикаций' })).toBeVisible();
    const release = page.getByRole('button', { name: 'Проверка завершена — разрешить работу' });
    await expect(release).toBeDisabled();
    await page.getByRole('checkbox', { name: /Прежний управляющий API отключён/ }).check();
    await page.getByRole('button', { name: 'Сверить публикацию' }).click();
    await expect(page.getByText(/Найдено несколько подходящих размещений/)).toBeVisible();
    await expect(release).toBeDisabled();
    await page.locator('.recovery-publications').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.local-state/task12-recovery-viewport.png' });
    positive = true;
    await page.getByRole('button', { name: 'Сверить публикацию' }).click();
    await expect(release).toBeEnabled();
    await release.click();
    await expect(page.getByText(/Проверка установки подтверждена/)).toBeVisible();
    expect(bodies).toHaveLength(2);
});
