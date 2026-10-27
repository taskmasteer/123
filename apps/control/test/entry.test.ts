import {afterEach,expect,test,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetModules();});
test('actual Vercel fetch export returns unconfigured503 and configured anonymous401 without external calls',async()=>{
 const fetcher=vi.fn(()=>{throw new Error('Unexpected network');});vi.stubGlobal('fetch',fetcher);
 for(const name of ['DATABASE_URL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','PREVIEW_SIGNING_KEY','CONTROL_PUBLIC_ORIGIN','CONTROL_ALLOWED_ORIGINS'])vi.stubEnv(name,'');
 const entry=(await import('../api/index.js')).default;
 expect(typeof entry.fetch).toBe('function');
 expect((await entry.fetch(new Request('https://control.example/session'))).status).toBe(503);
 vi.stubEnv('DATABASE_URL','postgresql://fixture:fixture@127.0.0.1:1/never-connect');vi.stubEnv('SUPABASE_URL','https://auth.example');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','fixture-only');
 for(const path of ['/session','/admin/invitations','/sites'])expect((await entry.fetch(new Request('https://control.example'+path))).status).toBe(401);
 expect(fetcher).not.toHaveBeenCalled();
 expect(JSON.parse(await readFile('apps/control/vercel.json','utf8')).rewrites).toEqual([{source:'/(.*)',destination:'/api/index'}]);
});
