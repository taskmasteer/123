import { test, expect } from './fixture.js';
test('managed browser harness respects server capabilities and keeps remote failures remote', async ({ page, workerBridge }) => {
    // Auth/control responses are fixtures; this is browser UX evidence, not Supabase acceptance.
    const id = '11111111-1111-4111-8111-111111111111';
    let offline = false, revoked = false, paused = false, cancelled = false;
    let role = 'user', workerName = 'Windows machine', savedStage = 'validate';
    const fixtureJwt = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
    await page.route('https://fixture.supabase.co/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: fixtureJwt, refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user: { id, email: 'member@example.test', aud: 'authenticated', role: 'authenticated' } }) }));
    await page.route('https://control.example/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (offline)
            return route.abort('connectionrefused');
        if (revoked)
            return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Войдите в систему.' }, requestId: 'fixture' }) });
        let result: unknown;
        if (path === '/session')
            result = { principal: { userId: id, role }, mode: 'managed', capabilities: { admin: role === 'admin', edit: role !== 'user', generation: true, publish: false, export: false, preview: true, nativeModelSettings: false } };
        else if (path === '/sites')
            result = { items: [{ id, domain: 'managed.example', ownerId: id, assignedUserIds: [], input: { domain: 'managed.example' }, revision: 1, draftId: null, publishedId: '22222222-2222-4222-8222-222222222222', generationStatus: 'completed', domainStatus: 'unconfigured', job: null }], nextCursor: null };
        else if (path === '/catalog')
            result = { styles: [], references: [] };
        else if (path === '/admin/users')
            result = [{ id, email: 'member@example.test', role: 'admin', active: true }];
        else if (path === '/workers')
            result = [{ id, name: workerName, paused, revoked: false, lastHeartbeat: 1700000000000, jobs: [{ id, siteId: id, stage: savedStage, state: cancelled ? 'cancelled' : 'running' }] }];
        else if (path === `/workers/${id}/pause`) {
            paused = true;
            result = { ok: true };
        }
        else if (path === `/sites/${id}/jobs/cancel`) {
            cancelled = true;
            result = { ok: true };
        }
        else if (path === '/admin/integrations')
            result = { database: 'configured', auth: 'configured', storage: 'configured', queue: 'unavailable', publication: 'unavailable', invitations: 'unavailable' };
        else
            return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fixture' }, requestId: 'fixture' }) });
        return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,OPTIONS' }, body: JSON.stringify(result) });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await page.getByLabel('Адрес общего API').fill('https://control.example');
    await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co');
    await page.getByLabel('Publishable key').fill('sb_publishable_fixture');
    await page.getByLabel('Email', { exact: true }).fill('member@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('fixture-only-password');
    await page.getByRole('button', { name: 'Войти в общий реестр' }).click();
    await expect(page.getByText('managed.example', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Правки managed.example' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Устройство', exact: true })).toHaveCount(0);
    const nativeRequests = workerBridge.requests.length;
    offline = true;
    await expect(page.getByText('Нет связи с общим API.', { exact: true })).toBeVisible();
    expect(workerBridge.requests.length).toBe(nativeRequests);
    await page.screenshot({ path: '.local-state/managed-offline-harness.png', fullPage: true });
    offline = false;
    role = 'admin';
    await page.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
    // Reconnect explicitly so the fixture demonstrates the newly resolved server role.
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await page.getByLabel('Адрес общего API').fill('https://control.example');
    await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co');
    await page.getByLabel('Publishable key').fill('sb_publishable_fixture');
    await page.getByLabel('Email', { exact: true }).fill('member@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('fixture-only-password');
    await page.getByRole('button', { name: 'Войти в общий реестр' }).click();
    await page.getByRole('button', { name: 'Подключения', exact: true }).click();
    await expect(page.getByText('Облачная очередь', { exact: true })).toBeVisible();
    await expect(page.getByText('Не подключено', { exact: true })).toHaveCount(3);
    await page.setViewportSize({ width: 1040, height: 680 });
    await page.screenshot({ path: '.local-state/managed-integrations-harness.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Пользователи', exact: true }).click();
    await expect(page.getByLabel('Роль member@example.test')).toBeVisible();
    expect(JSON.stringify(workerBridge.requests)).not.toContain('fixture-only-password');
    await page.getByRole('button', { name: 'Исполнители', exact: true }).click();
    await expect(page.getByText('Windows machine', { exact: true })).toBeVisible();
    await expect(page.getByText('Проверка · Выполняется', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Продолжить выдачу', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Отменить задание', exact: true }).click();
    await expect(page.getByText('Проверка · Отменено', { exact: true })).toBeVisible();
    workerName = 'Windows machine — рабочее устройство для восстановления сохранённых заданий';
    savedStage = 'validate-awaiting-checkpoint-confirmation-after-reconnection';
    await expect(page.getByText(workerName + ' · пауза', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1040, height: 680 });
    await page.screenshot({ path: '.local-state/managed-workers-harness.png', fullPage: true });
    role = 'user';
    await expect(page.getByRole('button', { name: 'Пользователи', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('API-ключ OpenAI')).toHaveCount(0);
    revoked = true;
    await expect(page.getByRole('heading', { name: 'Подключение к общему API' })).toBeVisible();
    await expect(page.getByText('managed.example', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Устройство', exact: true })).toHaveCount(0);
});
test('managed registry navigates beyond50, retries a page and resets cursors on role/session/local changes', async ({ page, workerBridge }) => {
    const owner = '11111111-1111-4111-8111-111111111111', revision = '22222222-2222-4222-8222-222222222222';
    const makeSite = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, domain: `managed-${n}.example`, ownerId: owner, assignedUserIds: [], input: { domain: `managed-${n}.example` }, revision: 1, draftId: null, publishedId: revision, generationStatus: 'completed', domainStatus: 'unconfigured', job: null });
    const sites = Array.from({ length: 51 }, (_, i) => makeSite(i + 1)), cursor = sites[49]!.id, requests: string[] = [];
    let failSecond = false, revoked = false, role = 'spec-user';
    const jwt = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: owner, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
    await page.route('https://fixture.supabase.co/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: jwt, refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user: { id: owner, email: 'member@example.test', aud: 'authenticated' } }) }));
    await page.route('https://control.example/**', route => {
        const req = route.request(), url = new URL(req.url());
        let result: unknown;
        if (revoked)
            return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Войдите в систему.' }, requestId: 'fixture' }) });
        if (url.pathname === '/session')
            result = { principal: { userId: owner, role }, mode: 'managed', capabilities: { admin: false, edit: role === 'spec-user', generation: false, publish: false, export: false, preview: true, nativeModelSettings: false } };
        else if (url.pathname === '/catalog')
            result = { styles: [], references: [] };
        else if (url.pathname === '/sites' && req.method() === 'POST') {
            const site = makeSite(52);
            site.domain = req.postDataJSON().domain;
            site.input.domain = site.domain;
            sites.push(site);
            result = site;
        }
        else if (url.pathname === '/sites') {
            const after = url.searchParams.get('cursor');
            requests.push(after ?? 'first');
            if (after) {
                expect(after).toBe(cursor);
                if (failSecond)
                    return route.abort('connectionrefused');
                result = { items: sites.slice(50), nextCursor: null };
            }
            else
                result = { items: sites.slice(0, 50), nextCursor: cursor };
        }
        else
            throw Error('Unexpected control route');
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
    });
    const login = async () => { await page.getByLabel('Адрес общего API').fill('https://control.example'); await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co'); await page.getByLabel('Publishable key').fill('sb_publishable_fixture'); await page.getByLabel('Email', { exact: true }).fill('member@example.test'); await page.getByLabel('Пароль', { exact: true }).fill('fixture-password'); await page.getByRole('button', { name: 'Войти в общий реестр', exact: true }).click(); };
    await page.goto('/');
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await login();
    await expect(page.getByText('managed-50.example', { exact: true })).toBeVisible();
    await expect(page.getByText('managed-51.example', { exact: true })).toHaveCount(0);
    expect(requests.every(c => c === 'first')).toBe(true);
    const pager = page.getByRole('navigation', { name: 'Страницы общего реестра' }), next = pager.getByRole('button', { name: 'Следующая страница' }), previous = pager.getByRole('button', { name: 'Предыдущая страница' });
    await expect(next).toBeEnabled();
    await expect(previous).toBeDisabled();
    const nativeCalls = workerBridge.requests.length;
    failSecond = true;
    await next.click();
    await expect(page.getByText('Нет связи с общим API.', { exact: true })).toBeVisible();
    await expect(page.getByText('managed-1.example', { exact: true })).toHaveCount(0);
    await expect(previous).toBeEnabled();
    failSecond = false;
    await page.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
    await expect(page.getByText('managed-51.example', { exact: true })).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(pager).toContainText('Страница 2');
    await page.getByRole('button', { name: 'Создать сайт', exact: true }).click();
    await page.getByLabel('Домен', { exact: true }).fill('new-after-page50.example');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect(pager).toContainText('Страница 1');
    await next.click();
    await expect(page.getByText('new-after-page50.example', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.local-state/managed-pagination-harness.png', fullPage: true });
    await previous.click();
    await expect(page.getByText('managed-1.example', { exact: true })).toBeVisible();
    await next.click();
    await expect(page.getByText('managed-51.example', { exact: true })).toBeVisible();
    role = 'user';
    await expect(pager).toContainText('Страница 1');
    await expect(page.getByRole('button', { name: 'Правки managed-1.example', exact: true })).toBeDisabled();
    await next.click();
    await expect(page.getByText('managed-51.example', { exact: true })).toBeVisible();
    revoked = true;
    await expect(page.getByRole('heading', { name: 'Подключение к общему API' })).toBeVisible();
    revoked = false;
    await login();
    await expect(pager).toContainText('Страница 1');
    await expect(previous).toBeDisabled();
    expect(workerBridge.requests.length).toBe(nativeCalls);
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await page.getByRole('button', { name: 'Перейти в локальный режим', exact: true }).click();
    await expect(pager).toHaveCount(0);
});
