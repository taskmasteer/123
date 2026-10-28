import { test, expect } from '@playwright/test';
import { selectionDocument, openSelection } from '../../apps/worker/src/preview/selection.js';
import { createEditableMap } from '../../packages/core/src/visual/editable-map.js';
import { projectSelection } from '../../packages/core/src/visual/projection.js';
import { acceptSelection, type SelectionSession } from '../../apps/desktop/src/features/editor/preview-bridge.js';
test('real Chromium selection bridge works under its nonce CSP; generated execution, egress and navigation stay disabled', async ({ page }) => {
    const files = [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<!doctype html><html lang="en"><head><script>window.pwned=true;fetch("https://trap.invalid")</script></head><body><h1 onclick="window.pwned=true">Selectable title</h1><a href="https://trap.invalid" target="_top">Blocked link</a><iframe src="https://trap.invalid"></iframe><form action="https://trap.invalid"></form></body></html>') }];
    const map = createEditableMap(files, { siteId: 'site', revisionId: 'revision', manifestId: 'manifest' }), projection = projectSelection(files, map), config = { sessionId: 'session', token: 'token', mapId: map.binding.mapId, revisionId: 'revision', documentPath: 'index.html' };
    const { html, policy } = selectionDocument(projection.documents[0]!.html, config, 'fixednonce');
    let trap = 0;
    page.on('request', r => {
        if (r.url().includes('trap.invalid'))
            trap++;
    });
    await page.route('https://selection.test/**', r => r.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': policy }, body: html }));
    await page.goto('https://selection.test/');
    await page.getByRole('heading').click();
    const selection = await page.evaluate(() => (window as any).__siteFactorySelection);
    const session: SelectionSession = { ...config, projection, sequence: 0, active: true };
    const source = {};
    expect(acceptSelection(selection, session, {}, source)).toBeNull();
    expect(acceptSelection({ ...selection, token: 'wrong' }, session, source, source)).toBeNull();
    expect(acceptSelection({ ...selection, save: true }, session, source, source)).toBeNull();
    expect(acceptSelection(selection, session, source, source)?.elementId).toBe(map.elements.find(e => e.tag === 'h1')!.elementId);
    expect(acceptSelection(selection, session, source, source)).toBeNull();
    session.active = false;
    expect(acceptSelection({ ...selection, sequence: 10 }, session, source, source)).toBeNull();
    await page.getByText('Blocked link').click();
    expect(page.url()).toBe('https://selection.test/');
    expect(trap).toBe(0);
    expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__TAURI_INTERNALS__)).toBeUndefined();
    expect(await page.locator('iframe,form').count()).toBe(0);
    const driver = await openSelection(projection, undefined, { headless: true });
    try {
        expect(await driver.status()).toEqual({ active: true, selection: null });
    }
    finally {
        await driver.close();
    }
    expect((await driver.status()).active).toBe(false);
});
test('a missing bridge nonce cannot masquerade as a functioning secure selection window', async ({ page }) => { const { html, policy } = selectionDocument('<html><head></head><body><h1>Title</h1></body></html>', { sessionId: 's', token: 't', mapId: 'm', revisionId: 'r', documentPath: 'index.html' }, 'correct'); await page.route('https://selection.test/**', r => r.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': policy }, body: html.replace('nonce="correct"', 'nonce="wrong"') })); await page.goto('https://selection.test/'); expect(await page.evaluate(() => Object.getOwnPropertyDescriptor(window, '__siteFactorySelection'))).toBeUndefined(); });
