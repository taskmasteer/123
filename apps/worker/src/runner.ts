import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../../packages/contracts/src/model.js';
import { runJob, type WorkerDeps } from './pipeline.js';
import {runHealth} from './health/scheduler.js';
export const maxParallelJobsPerDevice = 2;
/** The DB also enforces the device cap across competing processes. */
export async function runWorker(deps: WorkerDeps, workerId: string, signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    signal = AbortSignal.any([signal, stop.signal]);
    async function consume() {
        let failures = 0;
        while (!signal.aborted) {
            let claimed;
            try { claimed = await deps.queue.claim(workerId); failures = 0; }
            catch (error) {
                if (signal.aborted) return;
                const code = (error as {code?:string})?.code;
                if (!(error instanceof AppError && error.code === 'UNAVAILABLE') &&
                    !['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','57P01','57P02','57P03','08006','08003','53300'].includes(code ?? '')) throw error;
                const wait = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
                try { await delay(wait, undefined, {signal}); } catch { if (!signal.aborted) throw error; }
                continue;
            }
            if (!claimed) {
                try {
                    await delay(1000, undefined, { signal });
                }
                catch {
                    if (!signal.aborted)
                        throw new AppError('UNAVAILABLE', 'Ожидание очереди прервано.');
                }
                continue;
            }
            if (signal.aborted) {
                await deps.queue.finish(claimed.lease, 'paused');
                return;
            }
            try {
                await runJob(claimed.job, claimed.lease, deps.bind ? await deps.bind(claimed.job, claimed.lease, signal) : deps, signal);
            }
            catch (error) {
                if (!(error instanceof AppError && error.code === 'STALE_LEASE'))
                    throw error;
            }
        }
    }
    async function publications(){
      if(!deps.queue.continuePublications)return;
      while(!signal.aborted){
        let wait=3000;
        try{await deps.queue.continuePublications();}
        catch(error){if(error instanceof AppError&&['UNAUTHENTICATED','STALE_LEASE'].includes(error.code))throw error;wait=15000;}
        try{await (deps.delay??((ms,abort)=>delay(ms,undefined,{signal:abort})))(wait,signal);}catch{if(!signal.aborted)throw new AppError('UNAVAILABLE','Ожидание публикации прервано.');}
      }
    }
    const tasks=[...Array.from({ length:maxParallelJobsPerDevice },()=>consume),publications,...(deps.health?Array.from({length:2},()=>()=>runHealth(deps.health!,signal)):[])];
    const results = await Promise.allSettled(tasks.map(task => task().catch(error => {
        stop.abort();
        throw error;
    })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected')
        throw failed.reason;
}
