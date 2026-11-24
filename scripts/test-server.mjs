if(process.argv.includes('--isolated')){await import('./test-server-fixture.mjs');process.exit(process.exitCode??0);}
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','apps/server/test/audit-regressions.test.ts','apps/server/test/site-upload.test.ts','apps/server/test/job-diagnostic.test.ts','apps/server/test/server.test.ts','apps/server/test/operations.test.ts','apps/server/test/file-store.test.ts','apps/server/test/linux-secrets.test.ts','apps/desktop/test/session.test.ts','apps/worker/test/mentioned-link.test.ts','apps/server/test/hosting.test.ts','packages/adapters/test/deepseek.test.ts','--maxWorkers=1','--no-file-parallelism'],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,SITE_FACTORY_SERVER_TEST:'1',PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH??resolve(root,'.local-state/browsers')}});
process.exitCode=result.status??1;
