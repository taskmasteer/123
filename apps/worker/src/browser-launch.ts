import type { LaunchOptions } from 'playwright';
import { isAbsolute, join } from 'node:path';
/** Shared by validation, preview and selection. Capabilities are never renderer inputs. */
export function browserLaunchOptions(headless: boolean, environment: NodeJS.ProcessEnv = process.env, platform: string = process.platform): LaunchOptions & {env:Record<string,string>} {
  const env: Record<string,string> = {};
  for (const key of ['SystemRoot','WINDIR','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','LANG','LC_ALL']) if (environment[key] !== undefined) env[key]=environment[key];
  if (environment.SITE_FACTORY_PACKAGED==='1'&&platform==='win32') {
    const root=environment.SITE_FACTORY_RUNTIME_ROOT;
    if(!root||!isAbsolute(root))throw new Error('Ресурсы браузера недоступны. Восстановите или переустановите приложение.');
    // A supported explicit path avoids Playwright's mutable registry marker in
    // the immutable resource tree. Missing DLLs/launch failure still fail closed.
    const executable=headless?'chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe':'chromium-1248/chrome-win64/chrome.exe';
    return {headless,chromiumSandbox:true,env,executablePath:join(root,'browsers',executable)};
  }
  if (platform==='darwin' && environment.SITE_FACTORY_PACKAGED==='1') {
    const root=environment.SITE_FACTORY_RUNTIME_ROOT, socket=environment.SITE_FACTORY_GUARD_SOCKET, token=environment.SITE_FACTORY_GUARD_TOKEN;
    if (!root||!isAbsolute(root)||!socket||!isAbsolute(socket)||!token||!/^[a-f0-9]{64}$/.test(token)) throw new Error('Локальный владелец браузера недоступен. Перезапустите приложение.');
    Object.assign(env,{SITE_FACTORY_RUNTIME_ROOT:root,SITE_FACTORY_GUARD_SOCKET:socket,SITE_FACTORY_GUARD_TOKEN:token,SITE_FACTORY_BROWSER_KIND:headless?'headless':'full'});
    return {headless,chromiumSandbox:true,env,executablePath:join(root,'helpers/site-factory-runtime-guard')};
  }
  return { headless, chromiumSandbox: true, env };
}
