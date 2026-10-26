import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import type { ArtifactFile, ValidationReport } from '../../../../packages/contracts/src/model.js';
import { privateDirectory, writeExclusive } from '../../../../packages/adapters/src/safe-files.js';
import { serveFiles } from '../preview/server.js';
import { localReference, validateStatic } from './static.js';
import type { Issue } from './static.js';

const deadlineMs = 10_000;
// Deliberate allowlist: never inherit provider keys, proxy settings or application secrets.
function browserEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}
class ValidationTimeout extends Error {}

/** Generated JS executes only in a sandboxed Chromium renderer, never Node/eval/vm.
 * A new browser and incognito context own every run; failures remain fail-closed.
 */
export async function validateSite(files: ArtifactFile[]): Promise<ValidationReport> {
  const preflight = validateStatic(files); if (!preflight.ok) return preflight;
  const issues: Issue[] = []; const screenshotIds: string[] = [];
  const add = (code: string, message: string, path?: string) => {
    if (issues.length < 100 && !issues.some((issue) => issue.code === code && issue.message === message && issue.path === path)) {
      issues.push(path === undefined ? { code, message } : { code, message, path });
    }
  };
  const preview = await serveFiles(files); let browser: Browser | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  const origin = new URL(preview.url).origin;
  const paths = new Set(files.map((file) => file.path));
  const documents = files.filter((file) => file.mediaType === 'text/html');
  try {
    const work = async () => {
      browser = await chromium.launch({ headless: true, chromiumSandbox: true, env: browserEnvironment(), timeout: 5_000 });
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, permissions: [], javaScriptEnabled: true });
      context.setDefaultTimeout(2_000); context.setDefaultNavigationTimeout(2_500);
      await context.addInitScript(() => {
        // Keep a diagnostic channel even if generated code replaces console.error.
        const report = console.error.bind(console);
        if (typeof ServiceWorkerContainer !== 'undefined') {
          Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { configurable: false, writable: false, value: () => {
            report('Site policy: service workers are forbidden.');
            return Promise.reject(new DOMException('Service workers are forbidden.', 'SecurityError'));
          } });
        }
        // Peer connections can send UDP outside HTTP interception and CSP connect-src.
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
          Object.defineProperty(window, name, { configurable: false, writable: false, value: class {
            constructor() { report('Site policy: peer connections are forbidden.'); throw new DOMException('Peer connections are forbidden.', 'SecurityError'); }
          } });
        }
        const blockedDownload = (element: Element) => {
          if (element.closest('a[download]')) { report('Site policy: downloads are forbidden.'); return true; }
          return false;
        };
        const click = HTMLElement.prototype.click;
        Object.defineProperty(HTMLElement.prototype, 'click', { configurable: false, writable: false, value: function(this: HTMLElement) {
          if (!blockedDownload(this)) click.call(this);
        } });
        document.addEventListener('click', (event) => {
          if (event.target instanceof Element && blockedDownload(event.target)) event.preventDefault();
        }, true);
      });
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url());
        // Only this exact preview origin and GET/HEAD requests can reach a socket.
        if (target.origin !== origin || !['GET', 'HEAD'].includes(route.request().method())) {
          add('external-request', 'Blocked request to ' + target.origin); await route.abort('blockedbyclient'); return;
        }
        await route.continue();
      });
      await context.routeWebSocket('**/*', (socket) => { add('external-request', 'WebSockets are forbidden.'); socket.close(); });
      let primaryPage = false;
      context.on('page', (page) => {
        if (primaryPage) { add('popup', 'Popups are forbidden.'); void page.close(); }
        else primaryPage = true;
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => add('browser-error', error.message));
      page.on('console', (message) => { if (message.type() === 'error') add('browser-error', message.text()); });
      page.on('download', (download) => { add('download', 'Downloads are forbidden.'); void download.cancel(); });
      page.on('response', (response) => { if (response.status() >= 400) add('broken-link', 'Resource returned ' + response.status() + ': ' + response.url()); });
      for (const width of [375, 1440]) {
        const runtimeIds = new Map<string, Set<string>>();
        const runtimeLinks: { source: string; raw: string }[] = [];
        await page.setViewportSize({ width, height: 900 });
        for (const artifact of documents) {
          await page.goto(preview.url + artifact.path, { waitUntil: 'load' });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const state = await page.evaluate(() => {
            const visible = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
            // Contrast is a heuristic for ordinary RGB text over solid backgrounds.
            // Images, gradients and non-RGB color spaces remain visible in screenshots.
            const lowContrast = (element: Element) => {
              const rgb = (value: string): number[] | null => {
                const match = value.match(/^rgba?\(([^)]+)\)$/); if (!match) return null;
                const parts = match[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
                if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
                return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
              };
              const blend = (front: number[], back: number[]) => front.slice(0, 3).map((channel, i) => channel * front[3]! + back[i]! * (1 - front[3]!));
              const style = getComputedStyle(element); const front = rgb(style.color); if (!front) return false;
              const ancestors: Element[] = []; let current: Element | null = element; let opacity = 1;
              while (current) { ancestors.unshift(current); current = current.parentElement; }
              let background = [255, 255, 255];
              for (const ancestor of ancestors) {
                const computed = getComputedStyle(ancestor); opacity *= Number.parseFloat(computed.opacity);
                if (computed.backgroundImage !== 'none') return false;
                const color = rgb(computed.backgroundColor); if (color) background = blend(color, background);
              }
              front[3] = front[3]! * opacity;
              const luminance = (color: number[]) => color.map((channel) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i]!, 0);
              const a = luminance(blend(front, background)); const b = luminance(background);
              const large = Number.parseFloat(style.fontSize) >= 24 || (Number.parseFloat(style.fontSize) >= 18.66 && Number.parseInt(style.fontWeight) >= 700);
              return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < (large ? 3 : 4.5);
            };
            const textElements = Array.from(document.querySelectorAll('body *')).filter((element) => visible(element) && Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
            return {
              overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
              unreadable: textElements.some((element) => Number.parseFloat(getComputedStyle(element).fontSize) < 12 || lowContrast(element)),
              empty: !document.body.innerText.trim(),
              form: !!document.querySelector('form,input,textarea,select,[formaction],[form]'),
              links: Array.from(document.querySelectorAll('a[href]')).map((anchor) => anchor.getAttribute('href')!),
              ids: Array.from(document.querySelectorAll('[id],a[name]')).map((element) => element.id || element.getAttribute('name')!),
            };
          });
          if (state.overflow) add('overflow', 'Horizontal overflow at ' + width + 'px.', artifact.path);
          if (state.unreadable || state.empty) add('readability', 'Missing text, text smaller than 12px, or low solid-background RGB contrast at ' + width + 'px.', artifact.path);
          if (state.form) add('form', 'A form was created by JavaScript.', artifact.path);
          runtimeIds.set(artifact.path, new Set(state.ids));
          runtimeLinks.push(...state.links.map((raw) => ({ source: artifact.path, raw })));
          const id = randomUUID() + '.png';
          const directory = await privateDirectory(join(process.cwd(), '.local-state', 'validation'));
          const screenshot = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 2_000 });
          await writeExclusive(join(directory, id), screenshot); screenshotIds.push('validation/' + id);
        }
        for (const { source, raw } of runtimeLinks) {
            try {
              const reference = localReference(source, raw);
              if (!reference) continue;
              if (!paths.has(reference.path)) add('broken-link', 'Missing internal target: ' + raw, source);
              else if (reference.fragment && !runtimeIds.get(reference.path)?.has(reference.fragment)) add('broken-link', 'Missing anchor: ' + raw, source);
            } catch { add('broken-link', 'Unsafe link: ' + raw, source); }
        }
      }
    };
    await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ValidationTimeout('Validation exceeded its wall-clock deadline.')), deadlineMs); }),
    ]);
  } catch (error) {
    const timeout = error instanceof ValidationTimeout || (error instanceof Error && error.name === 'TimeoutError');
    add(timeout ? 'browser-timeout' : 'browser-unavailable', error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close(); await preview.close();
  }
  return { ok: issues.length === 0, issues, screenshotIds };
}
