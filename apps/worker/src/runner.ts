import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../../packages/contracts/src/model.js';
import { runJob, type WorkerDeps } from './pipeline.js';
export const maxParallelJobsPerDevice = 2;
/** The DB also enforces the device cap across competing processes. */
export async function runWorker(deps: WorkerDeps, workerId: string, signal: AbortSignal): Promise<void> {
    const stop = new AbortController();
    signal = AbortSignal.any([signal, stop.signal]);
    async function consume() {
        while (!signal.aborted) {
            const claimed = await deps.queue.claim(workerId);
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
                await runJob(claimed.job, claimed.lease, deps.bind ? await deps.bind(claimed.job, claimed.lease) : deps, signal);
            }
            catch (error) {
                if (!(error instanceof AppError && error.code === 'STALE_LEASE'))
                    throw error;
            }
        }
    }
    const results = await Promise.allSettled(Array.from({ length: maxParallelJobsPerDevice }, () => consume().catch(error => {
        stop.abort();
        throw error;
    })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected')
        throw failed.reason;
}
