import { test, expect } from './fixture.js';
test('managed owner sees provider DNS records and can resume automatic publication without edit authority', async ({ page }) => {
    const id = '11111111-1111-4111-8111-111111111111';
    let resumes = 0;
    const site = { id, domain: 'publication.example', ownerId: id, assignedUserIds: [], input: { domain: 'publication.example' }, revision: 0, draftId: null, publishedId: null, generationStatus: 'waiting_provider', domainStatus: 'unconfigured', job: { id, siteId: id, kind: 'generate', stage: 'publication', state: 'waiting_provider', checkpointId: id, baseRevision: 0 } };
    const publication = { id, siteId: id, revisionId: id, manifestId: id, manifestHash: 'a'.repeat(64), deploymentId: null, phase: 'awaiting_dns', retryAt: null, cancelRequested: false, settlement: 'pending', verifiedAt: null, origin: 'generation' };
    const jwt = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
    await page.route('https://fixture.supabase.co/**', route => route.fulfill({ json: { access_token: jwt, refresh_token: 'fixture', expires_in: 3600, user: { id, email: 'member@example.test', aud: 'authenticated', role: 'authenticated' } } }));
    await page.route('https://control.example/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/publication/resume') && ++resumes === 1)
            return route.fulfill({ status: 503, json: { requestId:'fixture-publication-resume',error: { code: 'UNAVAILABLE', message: 'Не удалось продолжить публикацию. Повторите после восстановления связи.' } } });
        const data = path === '/session' ? { principal: { userId: id, role: 'user' }, mode: 'managed', capabilities: { admin: false, edit: false, generation: true, publish: true, export: false, preview: true, nativeModelSettings: false } } :
            path === '/sites' ? { items: [site], nextCursor: null } : path === '/catalog' ? { styles: [], references: [] } :
                path.endsWith('/publication/resume') ? publication : path.endsWith('/publication') ? { publication, domain: { records: [{ type: 'CNAME', name: site.domain, value: 'target.vercel-dns.com' }, {type:'TXT',name:'_vercel.'+site.domain,value:'vc-domain-verify='+ 'long-provider-challenge-'.repeat(12)}], verified: false } } : { ok: true };
        return route.fulfill({ json: data });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Режим работы', exact: true }).click();
    await page.getByLabel('Адрес общего API').fill('https://control.example');
    await page.getByLabel('Адрес проекта Supabase').fill('https://fixture.supabase.co');
    await page.getByLabel('Publishable key').fill('sb_publishable_fixture');
    await page.getByLabel('Email', { exact: true }).fill('member@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('fixture-only-password');
    await page.getByRole('button', { name: 'Войти в общий реестр' }).click();
    await page.getByRole('button', { name: 'Публикация publication.example', exact: true }).click();
    await expect(page.getByText('target.vercel-dns.com', { exact: true })).toBeVisible();
    await expect(page.getByText('Записи меняются вручную у регистратора.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить публикацию', exact: true }).click();
    await expect.poll(() => resumes).toBe(1);
    await expect(page.getByRole('alert')).toContainText('Не удалось продолжить публикацию.');
    await page.waitForResponse(response=>response.url().endsWith('/publication')&&response.request().method()==='GET');
    await expect(page.getByRole('alert')).toContainText('Не удалось продолжить публикацию.');
    await expect(page.getByRole('button', { name: 'Опубликовать принятый черновик', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 1040, height: 680 });
    await page.screenshot({ path: '.local-state/publication-dns-harness.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Продолжить публикацию', exact: true }).click();
    await expect.poll(() => resumes).toBe(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
});
