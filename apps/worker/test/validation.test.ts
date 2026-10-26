import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as htmlParser from 'parse5';
import { validateSite } from '../src/validation/browser.js';
import { validateStatic } from '../src/validation/static.js';
import { createPreviewServer, serveFiles } from '../src/preview/server.js';
import { createLocalArtifacts } from '../../../packages/adapters/src/local-artifacts.js';
import { cleanDirectories, directory, file, site } from './fixtures.js';
vi.mock('parse5', async (importOriginal) => {
  const actual = await importOriginal<typeof import('parse5')>();
  return { ...actual, parse: vi.fn(actual.parse) };
});
vi.mock('../src/validation/static.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/validation/static.js')>();
  return { ...actual, validateStatic: vi.fn(actual.validateStatic) };
});
afterEach(cleanDirectories);

describe('static validation', () => {
  // Catches HTML parser bypasses and content-policy regressions before execution.
  it.each([
    ['form', site('<FORM><input name="email"></FORM>'), 'form'],
    ['broken file', site('<a href="missing.html">Details</a>'), 'broken-link'],
    ['broken anchor', site('<a href="#missing">Details</a>'), 'broken-link'],
    ['external image', site('<img src="https://example.com/image.png" alt="Tools">'), 'external-request'],
    ['module script', site('<script type="module" src="main.js"></script>').concat(file('main.js', '')), 'script-type'],
    ['base element', site('<base href="https://example.com/">'), 'active-content'],
    ['secret', site('<p>sk-proj-abcdefghijklmnopqrstuvwxyz123456</p>'), 'secret'],
    ['placeholder', site('<p>Lorem ipsum dolor sit amet</p>'), 'placeholder'],
  ])('rejects %s', (_name, files, code) => {
    const result = validateStatic(files); expect(result.ok).toBe(false); expect(result.issues.some((issue) => issue.code === code)).toBe(true);
  });
  // Catches resolving nested links from the root or checking anchors against the wrong document.
  it('resolves encoded internal links and anchors relative to their document', () => {
    const files = site('<a href="about/team.html#people">Team</a>').concat(file('about/team.html', '<html lang="en"><head><title>Team</title></head><body><h1 id="people">Our team</h1><a href="../index.html">Home</a></body></html>'));
    expect(validateStatic(files).ok).toBe(true);
    files[0] = file('index.html', '<a href="%2e%2e/secret.html">bad</a>'); expect(validateStatic(files).ok).toBe(false);
  });
  // Catches applying an HTML language requirement to parse5's synthetic SVG wrapper.
  it('accepts an ordinary local SVG without an HTML lang attribute', async () => {
    const logo = { path: 'logo.svg', mediaType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#111"/></svg>') };
    const files = site('<h1>Product information</h1><img src="logo.svg" alt="Product logo">').concat(logo);
    expect(validateStatic(files)).toMatchObject({ ok: true, issues: [] });
    const result = await validateSite(files); expect(result).toMatchObject({ ok: true, issues: [] }); expect(result.screenshotIds).toHaveLength(2);
  }, 30000);
  // Catches stack exhaustion on a small artifact before Chromium can enforce its deadline.
  it('reports excessive nesting for allowed-size HTML instead of throwing', async () => {
    const files = site('<div>'.repeat(5_000) + '<h1>Product information</h1>' + '</div>'.repeat(5_000));
    expect(files[0]!.bytes.byteLength).toBeLessThan(60_000);
    expect(validateStatic(files)).toMatchObject({ ok: false, issues: [{ code: 'document-complexity', path: 'index.html' }] });
    await expect(validateSite(files)).resolves.toMatchObject({ ok: false, issues: [{ code: 'document-complexity', path: 'index.html' }], screenshotIds: [] });
  });
  // Catches bounding depth without also bounding the total AST work for broad documents.
  it('reports excessive AST size for broad allowed-size HTML', () => {
    const files = site('<span>Readable details</span>'.repeat(11_000));
    expect(files[0]!.bytes.byteLength).toBeLessThan(400_000);
    expect(validateStatic(files)).toMatchObject({ ok: false, issues: [{ code: 'document-complexity', path: 'index.html' }] });
  });
  // Fault-inject a parser failure: real valid markup cannot reliably trigger a dependency crash.
  // Catches leaking a parser exception through either public validation boundary.
  it('returns a validation issue if the HTML parser fails unexpectedly', async () => {
    const parser = vi.mocked(htmlParser.parse).mockImplementation(() => { throw new RangeError('Parser failure'); });
    try {
      expect(validateStatic(site())).toMatchObject({ ok: false, issues: [{ code: 'static-error', path: 'index.html' }] });
      await expect(validateSite(site())).resolves.toMatchObject({ ok: false, issues: [{ code: 'static-error', path: 'index.html' }], screenshotIds: [] });
    } finally { parser.mockRestore(); }
  });
  // Fault-inject an unforeseen analyzer failure to exercise validateSite's public boundary.
  it('reports an unexpected static-preflight exception instead of rejecting', async () => {
    vi.mocked(validateStatic).mockImplementationOnce(() => { throw new Error('Unexpected analyzer failure'); });
    await expect(validateSite(site())).resolves.toMatchObject({ ok: false, issues: [{ code: 'static-error' }], screenshotIds: [] });
  });
});

describe('capability preview', () => {
  // Catches wide binding, serving outside the manifest, missing capability checks, and host mutation routes.
  it('serves only immutable current files behind a random loopback capability', async () => {
    const store = await createLocalArtifacts(await directory()); const saved = await store.put('s', site(), 'v1');
    const startPreview = createPreviewServer(store); const first = await startPreview(saved.id); const second = await startPreview(saved.id);
    try {
      expect(new URL(first.url).hostname).toBe('127.0.0.1'); expect(first.url).not.toBe(second.url);
      const response = await fetch(first.url); expect(response.status).toBe(200); expect(await response.text()).toContain('Clear product information');
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect((await fetch(new URL('/', first.url))).status).toBe(404);
      expect((await fetch(first.url + 'missing.css')).status).toBe(404);
      expect((await fetch(first.url + '%2e%2e/secret.css')).status).toBe(404);
      expect((await fetch(first.url, { method: 'POST', body: 'x' })).status).toBe(405);
      expect((await fetch(first.url + '__control')).status).toBe(404);
    } finally { await first.close(); await second.close(); }
    await expect(fetch(first.url)).rejects.toThrow();
  });
});

describe('real sandboxed Chromium', () => {
  // Catches browser checks being skipped and responsive regressions at either required width.
  it('accepts a readable responsive site and captures both viewports', async () => {
    const result = await validateSite(site('<h1 id="top">Clear product information</h1><p>Useful tools for growing teams.</p><a href="#top">Back to top</a>'));
    expect(result).toMatchObject({ ok: true, issues: [] }); expect(result.screenshotIds).toHaveLength(2);
    for (const id of result.screenshotIds) expect(Array.from((await readFile(join(process.cwd(), '.local-state', id))).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 30000);
  // Catches capability URLs breaking normal root-relative static resource URLs.
  it('supports root-relative local resources and safe URL encoding', async () => {
    const files = site('<h1>Product information</h1><a href="/%61bout.html">About</a>');
    files[0]!.bytes = new TextEncoder().encode(new TextDecoder().decode(files[0]!.bytes).replace('href="style.css"', 'href="/%73tyle.css"'));
    files.push(file('about.html', '<!doctype html><html lang="en"><head><title>About</title></head><body><h1>About our tools</h1></body></html>'));
    const result = await validateSite(files); expect(result).toMatchObject({ ok: true, issues: [] }); expect(result.screenshotIds).toHaveLength(4);
  }, 30000);
  // Catches missing pageerror/console monitoring or checking only the desktop width.
  it.each([
    ['runtime error', '<script src="main.js"></script>', '', 'throw new Error("broken product script")', 'browser-error'],
    ['mobile overflow', '<h1>Readable product page</h1>', '@media(max-width:400px){body{width:700px}}', '', 'overflow'],
    ['small text', '<p style="font-size:7px">Important details are unreadable</p>', '', '', 'readability'],
    ['invisible text', '<p style="color:white;background:white">Important details are unreadable</p>', '', '', 'readability'],
    ['dynamic broken anchor', '<script src="main.js"></script>', '', 'document.body.innerHTML="<a href=\\"#missing\\">Details</a>"', 'broken-link'],
  ])('rejects %s', async (_name, body, css, js, code) => {
    const files = site(body, css); if (js) files.push(file('main.js', js));
    const result = await validateSite(files); expect(result.ok).toBe(false); expect(result.issues.some((issue) => issue.code === code)).toBe(true);
  }, 30000);
  // Catches trusting the HTML anchor table after JavaScript removes a different page's target.
  it('rejects links to anchors removed at runtime in another local page', async () => {
    const files = site('<h1>Product information</h1><a href="about.html#team">About</a>');
    files.push(file('about.html', '<!doctype html><html lang="en"><head><title>About</title></head><body><h1 id="team">Our team</h1><script src="main.js"></script></body></html>'), file('main.js', 'document.getElementById("team").remove();document.body.append("Team information");'));
    const result = await validateSite(files); expect(result.ok).toBe(false); expect(result.issues.some((issue) => issue.code === 'broken-link')).toBe(true);
  }, 30000);
  // Catches external egress even when URLs are created dynamically in classic JS.
  it.each([
    ['HTTP fetch', (origin: string) => 'fetch("' + origin + '/fetch").catch(()=>{});'],
    ['WebSocket', (origin: string) => 'new WebSocket("' + origin.replace('http:', 'ws:') + '/socket");'],
    ['popup', (origin: string) => 'window.open("' + origin + '/popup");'],
    ['service worker', () => 'navigator.serviceWorker.register("worker.js").catch(()=>{});'],
    ['dedicated worker', () => 'new Worker("worker.js");'],
    ['WebRTC', () => 'new RTCPeerConnection();'],
    ['download', () => 'const a=document.createElement("a");a.href="data:text/plain,secret";a.download="secret.txt";a.click();'],
    ['dynamic image', (origin: string) => 'const image=new Image();image.src="' + origin + '/image.png";document.body.append(image);'],
  ])('blocks a real %s attempt', async (_name, script) => {
    const capturedExternalRequests: string[] = [];
    const trap = createServer((request, response) => { capturedExternalRequests.push(request.url!); response.end('external'); });
    trap.on('upgrade', (request, socket) => { capturedExternalRequests.push(request.url!); socket.destroy(); });
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
    const address = trap.address(); if (!address || typeof address === 'string') throw new Error('No trap address');
    const origin = 'http://127.0.0.1:' + address.port;
    const source = script(origin);
    try {
      const result = await validateSite(site('<h1>Product tools</h1><script src="main.js"></script>').concat(file('main.js', source), file('worker.js', 'fetch("' + origin + '/worker")')));
      expect(result.ok).toBe(false); expect(capturedExternalRequests).toHaveLength(0);
      expect(result.screenshotIds).toHaveLength(2);
      expect(result.issues.some((issue) => issue.code === 'browser-unavailable')).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => trap.close((error) => error ? reject(error) : resolve())); }
  }, 30000);
  // Catches generated code hanging the controller indefinitely.
  it('terminates a page with a runaway script within the validation deadline', async () => {
    const result = await validateSite(site('<script src="main.js"></script>').concat(file('main.js', 'while(true){}')));
    expect(result.ok).toBe(false); expect(result.issues.some((issue) => issue.code === 'browser-timeout')).toBe(true);
  }, 30000);
});
