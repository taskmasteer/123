import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import type { Projection, Selection } from '../../../../packages/contracts/src/visual.js';
import { AppError } from '../../../../packages/contracts/src/model.js';
import { verifiedProjection } from '../../../../packages/core/src/visual/projection.js';
import { escapeAttribute } from '../../../../packages/core/src/visual/html-patch.js';
import { acceptSelection, type SelectionSession } from '../../../../packages/contracts/src/visual-selection.js';
import { serveFiles } from './server.js';
import { browserEnvironment } from '../validation/browser.js';
const bridge = `(()=>{const c=JSON.parse(document.currentScript.dataset.config);let last=null,seq=0,at=0;Object.defineProperty(window,'__siteFactorySelection',{get:()=>last,configurable:false});for(const type of ['click','auxclick','submit','dragstart','drop'])document.addEventListener(type,e=>{e.preventDefault();e.stopImmediatePropagation();if(type!=='click'||performance.now()-at<50)return;const el=e.target instanceof Element?e.target.closest('[data-sf-element]'):null;if(!el)return;at=performance.now();document.querySelectorAll('[data-sf-selected]').forEach(e=>e.removeAttribute('data-sf-selected'));el.setAttribute('data-sf-selected','');last={version:1,...c,elementId:el.getAttribute('data-sf-element'),sequence:++seq};},true);})();`;
export function selectionDocument(html: string, config: Omit<Selection, 'version' | 'elementId' | 'sequence'>, nonce: string) {
    const script = `<script nonce="${nonce}" data-config="${escapeAttribute(JSON.stringify(config))}">${bridge}</script><style>[data-sf-selected]{outline:3px solid #3457bb!important;outline-offset:3px!important;cursor:crosshair!important}</style>`;
    const policy = `default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin`;
    return { html: html.replace('</head>', script + '</head>'), policy };
}
export interface SelectionDriver {
    sessionId: string;
    token: string;
    status(): Promise<{
        active: boolean;
        selection: Selection | null;
    }>;
    close(): Promise<void>;
}
export async function openSelection(input: Projection, documentPath?: string, options: {
    headless?: boolean;
} = {}): Promise<SelectionDriver> {
    const projection = verifiedProjection(input), document = projection.documents.find(d => d.path === (documentPath ?? projection.documents[0]!.path));
    if (!document)
        throw new AppError('INVALID_INPUT', 'Документ не найден.');
    const sessionId = randomUUID(), token = randomBytes(32).toString('base64url'), nonce = randomBytes(24).toString('base64url');
    const { html, policy } = selectionDocument(document.html, { sessionId, token, mapId: projection.binding.mapId, revisionId: projection.binding.revisionId, documentPath: document.path }, nonce);
    const server = await serveFiles([{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<!doctype html><title>Selection</title>') }]);
    let browser: Browser | undefined, page: Page | undefined, closed = false, loaded = false;
    const state: SelectionSession = { sessionId, token, projection, sequence: 0, active: true };
    const close = async () => {
        if (closed)
            return;
        closed = true;
        state.active = false;
        await browser?.close();
        await server.close();
    };
    try {
        browser = await chromium.launch({ headless: options.headless ?? false, chromiumSandbox: true, env: browserEnvironment(), timeout: 5000 });
        const context = await browser.newContext({ serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        context.setDefaultTimeout(2000);
        await context.route('**/*', async (route) => {
            if (route.request().url() === server.url + 'index.html' && !loaded && route.request().method() === 'GET')
                await route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': policy, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, body: html });
            else
                await route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', socket => socket.close());
        await context.addInitScript(() => {
            for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection'])
                Object.defineProperty(window, key, { value: undefined, writable: false, configurable: false });
        });
        page = await context.newPage();
        context.on('page', p => {
            if (p !== page)
                void p.close();
        });
        page.on('download', download => { void download.cancel(); });
        page.on('close', () => { void close(); });
        browser.on('disconnected', () => { void close(); });
        page.on('framenavigated', frame => {
            if (loaded || frame !== page!.mainFrame())
                void close();
        });
        await page.goto(server.url + 'index.html', { waitUntil: 'load', timeout: 5000 });
        loaded = true;
        if (!await page.evaluate(() => Object.getOwnPropertyDescriptor(window, '__siteFactorySelection')?.get !== undefined))
            throw new AppError('UNAVAILABLE', 'Мост выделения не запущен.');
        return { sessionId, token, async status() {
                if (!state.active || !page || page.isClosed())
                    return { active: false, selection: null };
                let value: unknown;
                try {
                    value = await page.evaluate(() => (window as unknown as {
                        __siteFactorySelection: unknown;
                    }).__siteFactorySelection);
                }
                catch {
                    await close();
                    return { active: false, selection: null };
                }
                return { active: state.active, selection: acceptSelection(value, state, page, page) };
            }, close };
    }
    catch (error) {
        await close();
        throw error;
    }
}
