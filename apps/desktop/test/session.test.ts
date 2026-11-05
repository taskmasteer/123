import {afterEach,test,expect,vi} from 'vitest';
import {appFetch,activateSession,clearSession,sessionExpiredEvent} from '../src/lib/native.js';
afterEach(()=>vi.unstubAllGlobals());
test('expiration emits once, pauses protected requests and ignores stale unauthorized responses after login',async()=>{
 const window=new EventTarget();vi.stubGlobal('window',window);
 let finish!:(response:Response)=>void;
 const fetch=vi.fn< typeof globalThis.fetch >().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(Response.json({error:{code:'UNAUTHENTICATED'}},{status:401}));vi.stubGlobal('fetch',fetch);
 let expirations=0;window.addEventListener(sessionExpiredEvent,()=>expirations++);
 activateSession();const old=appFetch('/api/sites');activateSession();finish(Response.json({},{status:401}));await old;expect(expirations).toBe(0);
 await appFetch('/api/sites');expect(expirations).toBe(1);await appFetch('/api/sites');expect(fetch).toHaveBeenCalledTimes(2);
 await clearSession();activateSession();fetch.mockResolvedValue(Response.json({ok:true}));expect((await appFetch('/api/sites')).status).toBe(200);
 await clearSession();
});
