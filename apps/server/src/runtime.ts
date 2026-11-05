import {MaintenanceGate} from './maintenance-gate.js';
import {createRecovery} from './recovery.js';
import {createMonitoring} from './monitoring.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { SupabaseRepository, configureSnapshotConnection } from '../../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../../packages/adapters/src/postgres-queue.js';
import { R2Store } from '../../../packages/adapters/src/r2-store.js';
import { createLocalCatalog } from '../../../packages/adapters/src/local-catalog.js';
import { readRegular, safeFile, privateDirectory } from '../../../packages/adapters/src/safe-files.js';
import { createDeepSeekModel } from '../../../packages/adapters/src/deepseek.js';
import { createApp } from '../../control/src/app.js';
import { createRemoteWorker } from '../../worker/src/remote-worker.js';
import { runWorker } from '../../worker/src/runner.js';
import { validateSite } from '../../worker/src/validation/browser.js';
import type { WorkerDeps } from '../../worker/src/pipeline.js';
import type { ModelPort } from '../../../packages/contracts/src/model.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import { FileObjectTransport } from './file-store.js';
import { LocalAuth, tokenHash } from './auth.js';
import { protectSecret } from './secrets.js';
import { createServers } from './servers.js';
import { createHosting } from './hosting.js';

export async function createServerRuntime(pool:Pool,root:string,data:string,origin:string,overrideModel?:ModelPort){
  const repository=new SupabaseRepository(configureSnapshotConnection(pool,'direct')),queue=new PostgresQueue(repository),auth=new LocalAuth(pool);
  const objects=new FileObjectTransport(join(data,'objects')),store=new R2Store(repository,objects,queue);
  const servers=await createServers(pool,root,data);
  const hosting=await createHosting(pool,repository,store,data);
  repository.canAdmitBatchSite=hosting.canAdmitBatchSite;
  repository.onBatchSiteCreated=hosting.reserveBatchSite;
  const monitoring=await createMonitoring(pool);
  const gate=new MaintenanceGate();let held=(await pool.query("select value from factory.system_state where key='recovery_hold'")).rows[0]?.value===true;
  if(held){await servers.pause();await hosting.pause();await monitoring.pause();}
  const catalog=await createLocalCatalog(root,data),validationRoot=await privateDirectory(join(data,'validation'));
  const workerToken=randomBytes(32).toString('base64url'),workerId=randomUUID();
  await pool.query("insert into private.workers(id,name,token_hash) values($1,'API worker',$2)",[workerId,tokenHash(workerToken)]);
  const app=createApp({repository,queue,store,auth,previewKey:randomBytes(32),publicOrigin:origin,allowedOrigins:[origin],previewCookie:false});
  const transport:typeof fetch=async(input,init)=>{const request=new Request(input,init),u=new URL(request.url);if(u.origin==='https://storage.factory.invalid')return objects.upload(request);if(u.origin!=='https://control.factory.invalid')throw new Error('Unexpected internal destination');return app(request);};
  let workerAbort:AbortController|null=null,work:Promise<void>|null=null,lastError:string|null=null,configured=false,changing=false;
  async function stop(){workerAbort?.abort();await work;workerAbort=null;work=null;}
  let selectedModel:ModelPort|null=null;
  async function start(model:ModelPort){
    selectedModel=model;if(held)return;
    await stop();lastError=null;workerAbort=new AbortController();
    // Graceful host shutdown pauses jobs; explicit batch pauses remain authoritative.
    const paused=(await pool.query("select j.id from private.jobs j join private.workers w on w.id=j.last_worker_id where w.name in ('API worker','Windows VPS') and j.data->>'state'='paused' order by j.site_id")).rows;
    for(const job of paused)try{await queue.retry(job.id);}catch(error){if(!(error instanceof AppError&&error.code==='CONFLICT'))throw error;}
    // All data ports below are replaced with lease-scoped API ports by createRemoteWorker.bind.
    const denied=async():Promise<never>=>{throw new Error('Unbound worker port');};
    const local:WorkerDeps={autoPublish:false,generationChecks:'technical-only',clock:{now:Date.now},workspace:join(data,'attempts'),model,templates:catalog,
      queue:{enqueue:denied,claim:denied,heartbeat:denied,checkpoint:denied,finish:denied},
      sites:{create:denied,list:denied,get:denied,compareAndSet:denied},artifacts:{put:denied,read:denied},revisions:{get:denied,put:denied},checkpoints:{save:denied,load:denied},publication:{advance:denied},
      validate:(files,context)=>validateSite(files,{screenshotRoot:validationRoot,mentionedUrl:context?.siteInput.mentionedUrl}),readValidationScreenshot:id=>readRegular(join(validationRoot,id.replace(/^validation\//,'')),8000000)};
    const remote=createRemoteWorker({controlOrigin:'https://control.factory.invalid',storageOrigin:'https://storage.factory.invalid',workerId,workerToken,fetch:transport},local);
    work=runWorker(remote,workerId,workerAbort.signal).catch(error=>{lastError=error instanceof AppError?`Исполнитель остановился (${error.code}): ${error.message}`:'Исполнитель остановился. Проверьте журнал и перезапустите службу.';console.error(lastError);});
  }
  const saved=(await pool.query("select value from factory.settings where key='deepseek'")).rows[0];
  if(overrideModel){configured=true;await start(overrideModel);}else if(saved){try{await start(createDeepSeekModel(await protectSecret(saved.value,true)));configured=true;}catch{lastError='Не удалось открыть сохранённый ключ на этом сервере.';}}
  repository.beforeBatchCommit=async(tx,inputs)=>{
    if(!configured)throw new AppError('UNAVAILABLE','Сначала сохраните ключ DeepSeek в настройках.');
    await hosting.prepareBatch(tx,inputs);
  };
  const recovery=await createRecovery(pool,root,data,action=>gate.exclusive(async()=>{
    await Promise.all([servers.pause(),hosting.pause(),monitoring.pause()]);await stop();
    try{return await action();}finally{if(!held){servers.resume();hosting.resume();monitoring.resume();if(selectedModel)await start(selectedModel);}}
  }));
  return {app,repository,queue,store,auth,catalog,pool,hosting,servers,monitoring,recovery,gate,dataRoot:data,
    recoveryState:()=>({held,maintenance:gate.busy}),
    async resumeRecovery(){await pool.query("insert into factory.system_state values('recovery_hold','false') on conflict(key) do update set value='false'");held=false;servers.resume();hosting.resume();monitoring.resume();if(selectedModel)await start(selectedModel);},
    status:()=>({configured,running:!!work&&!lastError,error:lastError,model:'DeepSeek Flash'}),
    async configure(key:string){
      if(changing)throw new AppError('CONFLICT','Настройки уже сохраняются.');
      if(!/^[\x21-\x7e]{10,4096}$/.test(key))throw new AppError('INVALID_INPUT','Проверьте API-ключ.');
      changing=true;try{const encrypted=await protectSecret(key);await pool.query("insert into factory.settings values('deepseek',$1) on conflict(key) do update set value=$1",[encrypted]);await start(createDeepSeekModel(key));configured=true;}finally{changing=false;}
    },
    async close(){await recovery.close();await monitoring.close();await servers.close();await hosting.close();await stop();await pool.query('update private.workers set revoked_at=now() where id=$1',[workerId]);}
  };
}
export type ServerRuntime=Awaited<ReturnType<typeof createServerRuntime>>;
