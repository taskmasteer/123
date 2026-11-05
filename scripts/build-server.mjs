import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
for(const [args,cwd] of [[['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],root],[['../../node_modules/vite/bin/vite.js','build','--config','vite.web.config.ts'],resolve(root,'apps/desktop')]]){
  const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',windowsHide:true});if(result.status!==0)process.exit(result.status??1);
}
