import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../../../../packages/contracts/src/model.js';
import {healthIntervalMs,type HealthPort } from '../../../../packages/contracts/src/monitoring.js';
import { createHealthProbe } from './probe.js';
export async function runHealth(port: HealthPort, signal: AbortSignal, probe = createHealthProbe(), now = Date.now, sleep = (ms: number, s: AbortSignal) => delay(ms, undefined, { signal: s })) {
    let failures = 0;
    while (!signal.aborted) {
        try {
            const result = await port.claim(signal);
            signal.throwIfAborted();
            failures = 0;
            if (result.claim) {
                const observed = await probe(result.claim, signal);
                signal.throwIfAborted();
                await port.complete(result.claim, observed.code, signal);
            }
            else
                await sleep(Math.min(healthIntervalMs,Math.max(1000, result.nextWakeAt - (result.serverNow??now()))), signal);
        }
        catch (error) {
            if (signal.aborted)
                return;
            if (error instanceof AppError && ['STALE_LEASE', 'UNAUTHENTICATED', 'FORBIDDEN'].includes(error.code))
                throw error;
            await sleep(Math.min(300000, 5000 * 2 ** Math.min(failures++, 6)), signal).catch(e => { if (!signal.aborted)
                throw e; });
        }
    }
}
