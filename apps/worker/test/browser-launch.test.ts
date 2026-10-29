import { it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { browserLaunchOptions } from '../src/browser-launch.js';
it('packaged Mac browser launches through fixed private owner proxy with no provider environment', () => {
 const root=resolve('.local-state/synthetic-runtime');
 const options=browserLaunchOptions(true,{SITE_FACTORY_PACKAGED:'1',SITE_FACTORY_RUNTIME_ROOT:root,SITE_FACTORY_GUARD_SOCKET:join(root,'private.sock'),SITE_FACTORY_GUARD_TOKEN:'a'.repeat(64),OPENAI_API_KEY:'synthetic-forbidden',HTTPS_PROXY:'synthetic-forbidden',TMPDIR:join(root,'temp')},'darwin');
 expect(options.executablePath).toBe(join(root,'helpers/site-factory-runtime-guard'));
 expect(options.env?.SITE_FACTORY_BROWSER_KIND).toBe('headless');
 expect(options.chromiumSandbox).toBe(true);expect(JSON.stringify(options)).not.toContain('synthetic-forbidden');
});
it('packaged Mac fails closed without ownership capability instead of using a cached browser',()=>{
 expect(()=>browserLaunchOptions(false,{SITE_FACTORY_PACKAGED:'1',SITE_FACTORY_RUNTIME_ROOT:resolve('.')},'darwin')).toThrow();
});
it('packaged Windows uses exact immutable resource executables for both modes without a registry-cache launch',()=>{
 const root=resolve('.local-state/synthetic-runtime'),environment={SITE_FACTORY_PACKAGED:'1',SITE_FACTORY_RUNTIME_ROOT:root,PLAYWRIGHT_BROWSERS_PATH:'ambient-forbidden'};
 expect(browserLaunchOptions(true,environment,'win32').executablePath).toBe(join(root,'browsers/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe'));
 expect(browserLaunchOptions(false,environment,'win32').executablePath).toBe(join(root,'browsers/chromium-1248/chrome-win64/chrome.exe'));
 expect(()=>browserLaunchOptions(true,{SITE_FACTORY_PACKAGED:'1'},'win32')).toThrow();
});
