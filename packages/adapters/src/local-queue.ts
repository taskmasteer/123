import { AppError } from '../../contracts/src/model.js';
import type { Clock, Job, Lease, Queue } from '../../contracts/src/model.js';
import { record, nonemptyString } from '../../contracts/src/inputs.js';
import { privateJson } from './private-json.js';
import { validEditRequest } from '../../contracts/src/editing.js';
export interface LocalQueue extends Queue { get(id: string): Promise<Job | null>; current(siteId: string): Promise<Job | null>; cancel(id: string): Promise<void>; retry(id: string,recovery?:Job['providerRecovery']): Promise<void>; close(): Promise<void> }
interface Entry { job: Job; lease: Lease | null; generation: number }
interface State { version: 1; entries: Entry[] }
function validRecovery(value:unknown):value is NonNullable<Job['providerRecovery']>{return record(value)&&Object.keys(value).length===3&&['id','checkpointId','modelIdentity'].every(key=>nonemptyString(value[key])&&(value[key] as string).length<=160);}
const states = ['queued', 'running', 'paused', 'waiting_provider', 'needs_attention', 'completed', 'cancelled'];
export function validJob(value: unknown): value is Job {
  return record(value) && nonemptyString(value.id) && nonemptyString(value.siteId) && ['generate', 'edit'].includes(String(value.kind)) &&
    nonemptyString(value.stage) && states.includes(String(value.state)) && Number.isSafeInteger(value.baseRevision) && (value.baseRevision as number) >= 0 &&
    (value.edit === undefined || validEditRequest(value.edit)) &&
    (value.providerRecovery===undefined||validRecovery(value.providerRecovery))&&
    (value.checkpointId === null || nonemptyString(value.checkpointId)) && (value.generation === undefined || (record(value.generation) &&
      Number.isSafeInteger(value.generation.seed) && (value.generation.seed as number) >= 0 && nonemptyString(value.generation.styleId) && nonemptyString(value.generation.templateVersion)));
}
function parse(value: unknown): State {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every((e) => record(e) && validJob(e.job) &&
    ((e.job.state === 'running') === (e.lease !== null)) &&
    Number.isSafeInteger(e.generation) && (e.generation as number) >= 0 && (e.lease === null || (record(e.lease) && e.lease.jobId === e.job.id &&
      nonemptyString(e.lease.workerId) && Number.isSafeInteger(e.lease.expiresAt) && e.lease.generation === e.generation))) ||
    new Set(value.entries.map((e: Entry) => e.job.id)).size !== value.entries.length) throw new AppError('INVALID_INPUT', 'Invalid persisted queue.');
  return value as unknown as State;
}
export async function createLocalQueue(directory: string, clock: Clock): Promise<LocalQueue> {
  if (process.env.NODE_ENV === 'production') throw new AppError('FORBIDDEN', 'Local queue is a demonstration adapter.');
  const json = await privateJson<State>(directory, 'queue.json', { version: 1, entries: [] }, parse); let closed = false;
  function now() { const time = clock.now(); if (!Number.isSafeInteger(time)) throw new AppError('INVALID_INPUT', 'Invalid clock.'); return time; }
  function transaction<R>(operation: (state: State) => { value?: State; result: R }): Promise<R> {
    if (closed) return Promise.reject(new AppError('CONFLICT', 'Queue is closed.')); return json.transaction(operation);
  }
  function owned(state: State, lease: Lease) {
    const entry = state.entries.find((e) => e.job.id === lease.jobId);
    if (!entry?.lease || entry.job.state !== 'running' || entry.lease.workerId !== lease.workerId || entry.lease.generation !== lease.generation || entry.lease.expiresAt <= now()) throw new AppError('STALE_LEASE', 'The worker no longer owns this job.');
    return entry;
  }
  return {
    enqueue(job) { return transaction((state) => {
      if (!validJob(job) || job.state !== 'queued' || job.checkpointId !== null) throw new AppError('INVALID_INPUT', 'New jobs must be queued without a checkpoint.');
      if (state.entries.some((e) => e.job.id === job.id)) throw new AppError('CONFLICT', 'Job already exists.');
      state.entries.push({ job: structuredClone(job), lease: null, generation: 0 }); return { value: state, result: undefined };
    }); },
    claim(workerId) { return transaction((state) => {
      if (!nonemptyString(workerId)) throw new AppError('INVALID_INPUT', 'Worker ID is required.'); const time = now();
      if (state.entries.filter((e) => e.job.state === 'running' && e.lease && e.lease.workerId === workerId && e.lease.expiresAt > time).length >= 2) return { result: null };
      const entry = state.entries.find((e, index) => (e.job.state === 'queued' || (e.job.state === 'running' && e.lease!.expiresAt <= time)) &&
        !state.entries.some((other, i) => i !== index && other.job.siteId === e.job.siteId && !['completed', 'cancelled'].includes(other.job.state) &&
          (i < index || other.job.state === 'running')));
      if (!entry) return { result: null };
      entry.generation++; entry.job.state = 'running'; entry.lease = { jobId: entry.job.id, workerId, generation: entry.generation, expiresAt: time + 120_000 };
      return { value: state, result: structuredClone({ job: entry.job, lease: entry.lease }) };
    }); },
    heartbeat(lease) { return transaction((state) => { const entry = owned(state, lease); entry.lease!.expiresAt = now() + 120_000; return { value: state, result: structuredClone(entry.lease!) }; }); },
    checkpoint(lease, checkpoint) { return transaction((state) => {
      const entry = owned(state, lease);
      if (checkpoint.jobId !== entry.job.id || !nonemptyString(checkpoint.id) || !nonemptyString(checkpoint.stage)) throw new AppError('INVALID_INPUT', 'Checkpoint belongs to another job.');
      entry.job.checkpointId = checkpoint.id; entry.job.stage = checkpoint.stage; return { value: state, result: undefined };
    }); },
    finish(lease, status) { return transaction((state) => {
      if (!['paused', 'waiting_provider', 'needs_attention', 'completed', 'cancelled'].includes(status)) throw new AppError('INVALID_INPUT', 'Invalid final job state.');
      const entry = owned(state, lease); entry.job.state = status; entry.lease = null; return { value: state, result: undefined };
    }); },
    get(id) { return transaction((state) => ({ result: structuredClone(state.entries.find((e) => e.job.id === id)?.job ?? null) })); },
    current(siteId) { return transaction(state => ({ result: structuredClone(state.entries.find(e => e.job.siteId === siteId && !['completed', 'cancelled'].includes(e.job.state))?.job ?? state.entries.findLast(e => e.job.siteId === siteId)?.job ?? null) })); },
    cancel(id) { return transaction(state => {
      const entry = state.entries.find(e => e.job.id === id);
      if (!entry) throw new AppError('NOT_FOUND', 'Job does not exist.');
      if (entry.job.state === 'running') throw new AppError('CONFLICT', 'Дождитесь завершения текущей правки.');
      entry.job.state = 'cancelled'; entry.lease = null;
      return { value: state, result: undefined };
    }); },
    retry(id,recovery) { return transaction((state) => {
      const entry = state.entries.find((e) => e.job.id === id); if (!entry) throw new AppError('NOT_FOUND', 'Job does not exist.');
      if (!['paused', 'waiting_provider', 'needs_attention'].includes(entry.job.state)) throw new AppError('CONFLICT', 'Job cannot be retried in its current state.');
      if(recovery){
        if(!validRecovery(recovery)||entry.job.kind!=='generate'||entry.job.state!=='needs_attention'||entry.job.checkpointId!==recovery.checkpointId)throw new AppError('CONFLICT','Provider recovery does not match the failed checkpoint.');
        entry.job.providerRecovery=structuredClone(recovery);
      }
      entry.job.state = 'queued'; return { value: state, result: undefined };
    }); },
    async close() { closed = true; await json.transaction(() => ({ result: undefined })); },
  };
}
