import {runNode} from './lib/launcher.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
const args=process.argv.slice(2);
try{
 if(args.includes('--live')){
  const index=args.indexOf('--config');if(index<0||!args[index+1]||!isAbsolute(args[index+1]))throw new Error('Live pilot requires an explicitly selected absolute --config path; no credential discovery is performed.');
  const config=JSON.parse(await readFile(args[index+1]));
  if(config.personalNoncommercial!==true||!Array.isArray(config.demoDomains)||config.demoDomains.length<5||config.demoDomains.length>10||new Set(config.demoDomains).size!==config.demoDomains.length||config.demoDomains.some(d=>typeof d!=='string'||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)))throw new Error('Choose 5–10 explicit personal noncommercial demo domains.');
  const required=['controlOrigin','supabaseProject','r2Bucket','vercelAccount','openaiProject'];
  if(required.some(key=>typeof config.accounts?.[key]!=='string'||!config.accounts[key].trim()))throw new Error('Explicit existing control/Supabase/R2/Vercel/OpenAI accounts are required.');
  const url=new URL(config.accounts.controlOrigin);if(url.protocol!=='https:'||url.origin!==config.accounts.controlOrigin)throw new Error('Choose the configured HTTPS control origin.');
  console.log(JSON.stringify({mode:'live-preflight',configured:true,domains:config.demoDomains,execution:'pending explicit authorized environment/platform/visual run',checks:['sign-in/refresh/invitation','private R2 conditional uploads','generation/edit/visual/publish','DNS/HTTPS','two physical devices/failover','encrypted independent restore','user visual assessment'],mutations:0}));
 }else if(args.includes('--fixtures')){
  await mkdir('.local-state/pilot',{recursive:true});const began=Date.now();
  runNode('node_modules/typescript/bin/tsc',['-p','tsconfig.build.json']);
  runNode('scripts/test-e2e.mjs',['pilot.spec.ts','ai-edit.spec.ts','visual.spec.ts','recovery.spec.ts','invitation.spec.ts']);
  // The required full-volume gate runs once in verify. Pilot exercises the same
  // restore paths with bounded bodies instead of repeating the 940009 fixture.
  runNode('scripts/test-integration.mjs',['backup','native-managed-backup','recovery-visual','queue','health','-t','^(?!.*actual900009)']);
  await writeFile('.local-state/pilot/run.json',JSON.stringify({mode:'fixtures',passed:true,elapsedMs:Date.now()-began,realProviders:false,twoPhysicalDevices:false,fullProjectedBodies:false,platformAcceptance:false},null,2));
  console.log('Fixture pilot passed; actual platform/provider/physical-device/user-visual acceptance remains pending.');
 }else throw new Error('Choose --fixtures or --live with an explicit configured plan.');
}catch(error){console.error(error.message);process.exitCode=1;}
