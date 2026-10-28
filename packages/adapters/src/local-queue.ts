import { AppError } from '../../contracts/src/model.js';
import type { Job, Lease, Queue } from '../../contracts/src/model.js';
import { record, nonemptyString } from '../../contracts/src/inputs.js';
import { validEditRequest } from '../../contracts/src/editing.js';
export interface LocalQueue extends Queue {
    get(id: string): Promise<Job | null>;
    current(siteId: string): Promise<Job | null>;
    cancel(id: string): Promise<void>;
    retry(id: string, recovery?: Job['providerRecovery']): Promise<void>;
    close(): Promise<void>;
}
interface Entry {
    job: Job;
    lease: Lease | null;
    generation: number;
}
interface State {
    version: 1;
    entries: Entry[];
}
function validRecovery(value: unknown): value is NonNullable<Job['providerRecovery']> { return record(value) && Object.keys(value).length === 3 && ['id', 'checkpointId', 'modelIdentity'].every(key => nonemptyString(value[key]) && (value[key] as string).length <= 160); }
const states = ['queued', 'running', 'paused', 'waiting_provider', 'needs_attention', 'completed', 'cancelled'];
export function validJob(value: unknown): value is Job {
    return record(value) && nonemptyString(value.id) && nonemptyString(value.siteId) && ['generate', 'edit'].includes(String(value.kind)) &&
        nonemptyString(value.stage) && states.includes(String(value.state)) && Number.isSafeInteger(value.baseRevision) && (value.baseRevision as number) >= 0 &&
        (value.edit === undefined || validEditRequest(value.edit)) &&
        (value.providerRecovery === undefined || validRecovery(value.providerRecovery)) &&
        (value.checkpointId === null || nonemptyString(value.checkpointId)) && (value.generation === undefined || (record(value.generation) &&
        Number.isSafeInteger(value.generation.seed) && (value.generation.seed as number) >= 0 && nonemptyString(value.generation.styleId) && nonemptyString(value.generation.templateVersion)));
}
export function parseQueueState(value: unknown): State {
    if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every((e) => record(e) && validJob(e.job) &&
        ((e.job.state === 'running') === (e.lease !== null)) &&
        Number.isSafeInteger(e.generation) && (e.generation as number) >= 0 && (e.lease === null || (record(e.lease) && e.lease.jobId === e.job.id &&
        nonemptyString(e.lease.workerId) && Number.isSafeInteger(e.lease.expiresAt) && e.lease.generation === e.generation))) ||
        new Set(value.entries.map((e: Entry) => e.job.id)).size !== value.entries.length)
        throw new AppError('INVALID_INPUT', 'Invalid persisted queue.');
    return value as unknown as State;
}
export { createSqliteQueue as createLocalQueue } from './sqlite-queue.js';
