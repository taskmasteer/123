import {resolve} from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH??=resolve(import.meta.dirname,'../.local-state/browsers');
const {chromium}=await import('playwright');
const {browserLaunchOptions}=await import('../dist/apps/worker/src/browser-launch.js');
const browser=await chromium.launch(browserLaunchOptions(true));
try{const page=await browser.newPage();await page.setContent('<h1>Site Factory runtime check</h1>');if(await page.locator('h1').textContent()!=='Site Factory runtime check')throw Error('Browser rendering failed');console.log('Sandboxed generation browser: ready');}finally{await browser.close();}
