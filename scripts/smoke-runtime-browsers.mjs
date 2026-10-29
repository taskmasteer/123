import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkRuntime} from './lib/package-runtime.mjs';
try{
 const args=process.argv.slice(2),root=resolve(args[args.indexOf('--root')+1]??''),expected=args[args.indexOf('--expected-manifest-sha256')+1];
 await checkRuntime(root,expected,{target:'win32-x64'});
 if(process.platform!=='win32')throw Error('This component probe is Windows-only. Mac ownership must run through its native private helper.');
 const {chromium}=await import(pathToFileURL(join(root,'node_modules/playwright/index.mjs')).href),{browserLaunchOptions}=await import(pathToFileURL(join(root,'apps/worker/src/browser-launch.js')).href),results=[];
 const environment={...process.env,SITE_FACTORY_PACKAGED:'1',SITE_FACTORY_RUNTIME_ROOT:root};
 for(const selector of [true,false]){
  // Exercise the full Chrome selector in headless mode too. Never open a native
  // browser window; headful behavior is a separate matching-host acceptance gap.
  const options={...browserLaunchOptions(selector,environment,'win32'),headless:true,timeout:15000};
  const browser=await chromium.launch(options);
  try{const page=await browser.newPage();await page.setContent('<!doctype html><title>Packaged component</title><h1>Owned browser</h1>',{timeout:10000});if(await page.title()!=='Packaged component')throw Error('Packaged page did not run');results.push({selector:selector?'headless-shell':'full-chrome',headless:true,version:browser.version()});}
  finally{await browser.close();}
  await checkRuntime(root,expected,{target:'win32-x64'});
 }
 console.log(JSON.stringify({browsers:results,immutableAfterDispose:true,gui:false}));
}catch(error){console.error(error.stack??error.message);process.exitCode=1;}
