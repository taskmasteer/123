import {budgetedModel} from './model-budget.js';
import {createOriginalityRegistry} from './originality-registry.js';
import {reconcileRecovery} from './recovery-reconcile.js';
import {MaintenanceGate} from './maintenance-gate.js';
import {logFailure} from './diagnostics.js';
import {setTimeout as delay} from 'node:timers/promises';
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
  const gate=new MaintenanceGate();let held=(await pool.query("select value from factory.system_state where key='recovery_hold'")).rows[0]?.value===true;
  const servers=await createServers(pool,root,data,undefined,held);
  let hosting=await createHosting(pool,repository,store,data,undefined,held);
  repository.canAdmitBatchSite=hosting.canAdmitBatchSite;
  repository.onBatchSiteCreated=hosting.reserveBatchSite;
  const monitoring=await createMonitoring(pool,undefined,held);
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
    const local:WorkerDeps={originality:createOriginalityRegistry(queue,store),beforeGenerate:siteId=>hosting.generationPreflight(siteId),autoPublish:false,generationChecks:'technical-only',clock:{now:Date.now},workspace:join(data,'attempts'),model,templates:catalog,
      queue:{enqueue:denied,claim:denied,heartbeat:denied,checkpoint:denied,finish:denied},
      sites:{create:denied,list:denied,get:denied,compareAndSet:denied},artifacts:{put:denied,read:denied},revisions:{get:denied,put:denied},checkpoints:{save:denied,load:denied},publication:{advance:denied},
      validate:(files,context)=>validateSite(files,{screenshotRoot:validationRoot,mentionedUrl:context?.siteInput.mentionedUrl}),readValidationScreenshot:id=>readRegular(join(validationRoot,id.replace(/^validation\//,'')),8000000)};
    local.referenceNotes=async id=>{
      const reference=(await catalog.list()).references.find(item=>item.id===id);
      if(reference)return 'Reference art direction (data): '+JSON.stringify({palette:reference.palette,typography:reference.typography,density:reference.density,adaptations:reference.adaptations}).slice(0,1500);
    };
    const remote=createRemoteWorker({controlOrigin:'https://control.factory.invalid',storageOrigin:'https://storage.factory.invalid',workerId,workerToken,fetch:transport},local);
    const signal=workerAbort.signal;
    work=(async()=>{
      let failures=0;
      while(!signal.aborted){
        try{lastError=null;await runWorker(remote,workerId,signal);if(!signal.aborted)throw new Error('Worker exited unexpectedly');}
        catch(error){
          if(signal.aborted)return;
          logFailure('worker.supervisor',error);
          lastError='Исполнитель восстанавливает соединение. Задания сохранены.';
          if(error instanceof AppError&&['UNAUTHENTICATED','FORBIDDEN'].includes(error.code)){lastError='Доступ исполнителя отозван. Перезапустите службу после проверки доступа.';return;}
          try{await delay(Math.min(60000,1000*2**Math.min(failures++,6)),undefined,{signal});}catch{return;}
        }
      }
    })();
  }
  const saved=(await pool.query("select value from factory.settings where key='deepseek'")).rows[0];
  if(overrideModel){configured=true;await start(overrideModel);}else if(saved){try{await start(budgetedModel(pool,await protectSecret(saved.value,true),{job:Number(process.env.SITE_FACTORY_JOB_TOKEN_BUDGET??16000000),batch:Number(process.env.SITE_FACTORY_BATCH_TOKEN_BUDGET??4096000000)}));configured=true;}catch{lastError='Не удалось открыть сохранённый ключ на этом сервере.';}}
  repository.beforeBatchCommit=async(tx,inputs)=>{
    if(!configured)throw new AppError('UNAVAILABLE','Сначала сохраните ключ DeepSeek в настройках.');
    await hosting.prepareBatch(tx,inputs);
  };
  const recovery=await createRecovery(pool,root,data,action=>gate.exclusive(async()=>{
    await Promise.all([servers.pause(),hosting.pause(),monitoring.pause()]);await stop();
    try{return await action();}finally{if(!held){servers.resume();hosting.resume();monitoring.resume();if(selectedModel)await start(selectedModel);}}
  }));
  let cleaning:Promise<unknown>|null=null;
  const cleanup=setInterval(()=>{if(!cleaning)cleaning=pool.query("delete from factory.sessions where expires_at<now(); delete from factory.attempts where until_at<now(); delete from factory.invites where expires_at<now()-interval '7 days'").catch(e=>logFailure('auth.cleanup',e)).finally(()=>{cleaning=null;});},600000);cleanup.unref();
  let resuming=false;
  let retrying:Promise<void>|null=null;
  const retryTimer=setInterval(()=>{
    if(held||gate.busy||!configured||retrying)return;
    retrying=(async()=>{
      const jobs=(await pool.query("select j.id,j.checkpoint_id from private.jobs j left join private.batches b on b.id=j.batch_id where j.data->>'state'='waiting_provider' and (j.batch_id is null or b.state='active') order by j.id limit 256")).rows;
      for(const job of jobs){
        if(held||gate.busy)return;
        const saved=job.checkpoint_id?await store.load(job.checkpoint_id):null;
        const state=saved?.state as any,continuation=saved?.checkpoint.stage==='brief'?state?.planningContinuation:state?.continuation;
        if(Number(state?.hostingRetryAt??0)>Date.now()||continuation?.requestPending||continuation?.recoverable||Number(continuation?.retryAt??0)>Date.now())continue;
        try{await queue.retry(job.id);}catch(e){if(!(e instanceof AppError&&e.code==='CONFLICT'))throw e;}
      }
    })().catch(e=>logFailure('worker.provider-retry',e)).finally(()=>{retrying=null;});
  },30000);retryTimer.unref();
  return {app,repository,queue,store,auth,catalog,pool,get hosting(){return hosting;},set hosting(value){hosting=value;},servers,monitoring,recovery,gate,dataRoot:data,
    recoveryState:()=>({held,maintenance:gate.busy}),
    async resumeRecovery(){if(resuming)throw new AppError('CONFLICT','Проверка восстановления уже выполняется.');if(!held)return;resuming=true;try{await reconcileRecovery(pool,undefined,store);await pool.query("insert into factory.system_state values('recovery_hold','false') on conflict(key) do update set value='false'");held=false;servers.resume();hosting.resume();monitoring.resume();if(selectedModel)await start(selectedModel);}finally{resuming=false;}},
    status:()=>({configured,running:!!work&&!lastError,error:lastError,model:'DeepSeek Flash'}),
    async configure(key:string){
      if(changing)throw new AppError('CONFLICT','Настройки уже сохраняются.');
      if(!/^[\x21-\x7e]{10,4096}$/.test(key))throw new AppError('INVALID_INPUT','Проверьте API-ключ.');
      changing=true;try{const encrypted=await protectSecret(key);await pool.query("insert into factory.settings values('deepseek',$1) on conflict(key) do update set value=$1",[encrypted]);await start(budgetedModel(pool,key,{job:Number(process.env.SITE_FACTORY_JOB_TOKEN_BUDGET??16000000),batch:Number(process.env.SITE_FACTORY_BATCH_TOKEN_BUDGET??4096000000)}));configured=true;}finally{changing=false;}
    },
    async close(){clearInterval(cleanup);clearInterval(retryTimer);await cleaning;await retrying;await recovery.close();await monitoring.close();await servers.close();await hosting.close();await stop();await pool.query('update private.workers set revoked_at=now() where id=$1',[workerId]);}
  };
}
export type ServerRuntime=Awaited<ReturnType<typeof createServerRuntime>>;
