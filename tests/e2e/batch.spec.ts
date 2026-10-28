import { test, expect } from './fixture.js';
test('imports a staged file, corrects one description and retains invalid rows with batch controls', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Пачки', exact: true }).click();
    await page.getByLabel('Файл CSV или XLSX').setInputFiles({ name: 'sites.csv', mimeType: 'text/csv', buffer: Buffer.from('domain,about\nbatch-a.test,First\nbatch-b.test,Second\n,Missing domain\n') });
    await expect(page.getByText('Корректных строк: 2. С ошибками: 1.')).toBeVisible();
    await page.getByRole('button', { name: 'Изменить строку 3' }).click();
    await page.getByLabel('О сайте в строке 3').fill('Only the second site changed');
    await page.getByRole('button', { name: 'Сохранить строку' }).click();
    await expect(page.getByText('Only the second site changed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Запустить корректные строки' }).click();
    await expect(page.getByText('Домен: Укажите корректный домен.')).toBeVisible();
    await page.getByRole('button', { name: 'Пауза пачки', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Продолжить пачку' })).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить пачку' }).click();
    await expect(page.getByRole('button', { name: 'Пауза пачки' })).toBeVisible();
    await page.setViewportSize({ width: 1040, height: 680 });
    await page.screenshot({ path: '.local-state/batch-detail.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('managed batch browser keeps action failures visible across successful polls and clears old scope on identity change', async ({ page, workerBridge }) => {
    const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
    let identity = id, state = 'preview', revision = 1, about = 'First', pauseFails = true, polls = 0;
    const jwt = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
    await page.route('https://fixture.supabase.co/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: jwt, refresh_token: 'fixture', expires_in: 3600, token_type: 'bearer', user: { id, email: 'owner@example.test', aud: 'authenticated', role: 'authenticated' } }) }));
    const summary = () => ({ id, name: 'managed.csv', state, revision, total: 1, validCount: 1, invalidCount: 0, canControl: true });
    await page.route('https://control.example/**', async (route) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
        if (route.request().method() === 'OPTIONS')
            return route.fulfill({ status: 204, headers: cors });
        const url = new URL(route.request().url());
        let result: unknown;
        if (url.pathname === '/session')
            result = { principal: { userId: identity, role: 'user' }, mode: 'managed', capabilities: { admin: false, edit: false, generation: true, publish: false, export: false, preview: true, nativeModelSettings: false } };
        else if (url.pathname === '/sites')
            result = { items: [], nextCursor: null };
        else if (url.pathname === '/catalog')
            result = { styles: [], references: [] };
        else if (url.pathname === '/batches/commands') {
            const command = route.request().postDataJSON();
            expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThan(64000);
            switch (command.method) {
                case 'resource.begin':
                    result = { id };
                    break;
                case 'resource.chunk':
                    result = { ok: true };
                    break;
                case 'import.prepare':
                case 'import.update':
                    if (command.method === 'import.update') {
                        about = command.params.about;
                        revision++;
                    }
                    result = summary();
                    break;
                case 'import.commit':
                    state = 'active';
                    result = { batchId: id };
                    break;
                case 'batch.get':
                    polls++;
                    result = summary();
                    break;
                case 'batch.rows':
                    result = { items: [{ rowNumber: 2, input: { rowNumber: 2, domain: 'managed-row.test', about }, issues: [], siteId: state === 'preview' ? null : id, job: state === 'preview' ? null : { id, state: 'queued', stage: 'brief' } }], nextCursor: null };
                    break;
                case 'batch.pause':
                    if (pauseFails)
                        return route.fulfill({ status: 503, headers: cors, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Пауза временно недоступна.' }, requestId: 'fixture' }) });
                    state = 'paused';
                    result = { ok: true };
                    break;
                case 'batch.list':
                    result = { items: identity === id ? [summary()] : [], nextCursor: null };
                    break;
                default: throw new Error(command.method);
            }
        }
        else
            throw new Error(url.pathname);
        await route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify(result) });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await page.getByLabel('Адрес общего API').fill('https://control.example');
    await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co');
    await page.getByLabel('Publishable key').fill('sb_publishable_fixture');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('fixture-only');
    await page.getByRole('button', { name: 'Войти в общий реестр' }).click();
    await page.getByRole('button', { name: 'Пачки', exact: true }).click();
    await page.getByLabel('Файл CSV или XLSX').setInputFiles({ name: 'managed.csv', mimeType: 'text/csv', buffer: Buffer.from('domain,about\nmanaged-row.test,First') });
    await expect(page.getByText('Корректных строк: 1. С ошибками: 0.')).toBeVisible();
    await page.getByRole('button', { name: 'Запустить корректные строки' }).click();
    await page.getByRole('button', { name: 'Пауза пачки', exact: true }).click();
    await expect(page.getByText('Пауза временно недоступна.', { exact: true })).toBeVisible();
    const before = polls;
    await expect.poll(() => polls).toBeGreaterThan(before);
    await expect(page.getByText('Пауза временно недоступна.', { exact: true })).toBeVisible();
    pauseFails = false;
    await page.getByRole('button', { name: 'Пауза пачки', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Продолжить пачку' })).toBeVisible();
    expect(workerBridge.requests.some(r => r.method === 'resource.begin')).toBe(false);
    identity = other;
    await expect(page.getByText('managed-row.test', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Пачек пока нет.', { exact: true })).toBeVisible();
});
