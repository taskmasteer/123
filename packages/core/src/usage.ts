import type { ArtifactFile, Checkpoint } from '../../contracts/src/model.js';
import type { CheckpointProjection, CheckpointEvidence } from '../../contracts/src/recovery.js';
import { createHash } from 'node:crypto';
import { AppError } from '../../contracts/src/model.js';
import { record } from '../../contracts/src/inputs.js';
import { references } from './retention.js';
import type {JobUsage} from '../../contracts/src/recovery.js';
import type {JobActivity,UsageSummary} from '../../contracts/src/monitoring.js';
export function summarizeUsage(jobIds:string[],rows:JobUsage[],activity:JobActivity[],objects:{identity:string;size:number}[],completeInventory:boolean):UsageSummary {
 const jobs=new Set(jobIds), seen=new Set<string>(), measured=new Set<string>(), physical=new Map<string,number>();
 const summary:UsageSummary={jobs:jobs.size,measuredJobs:0,missingJobs:jobs.size,inputTokens:0,outputTokens:0,uncertainRequests:0,requestPending:false,tokenCoverage:'unknown',provenance:[],imageTokens:null,imagePending:null,durationMs:null,durationCoverage:'unknown',bytesStored:null,knownBytesStored:0,storageCoverage:completeInventory?'verified-inventory':'partial',estimatedCostUsd:null};
 const sum=(a:number,b:number)=>{if(!Number.isSafeInteger(b)||b<0||!Number.isSafeInteger(a+b))throw new AppError('INVALID_INPUT','Некорректный счётчик.');return a+b;};
 for(const row of rows){if(!jobs.has(row.jobId)||seen.has(row.jobId))throw new AppError('INVALID_INPUT','Проекция задания повторяется.');seen.add(row.jobId);summary.inputTokens=sum(summary.inputTokens,row.inputTokens);summary.outputTokens=sum(summary.outputTokens,row.outputTokens);summary.uncertainRequests=sum(summary.uncertainRequests,row.uncertainRequests);summary.requestPending ||=row.requestPending;if(row.imagePending===true)summary.imagePending=true;if(!summary.provenance.includes(row.provenance))summary.provenance.push(row.provenance);}
 summary.missingJobs=jobs.size-seen.size;summary.tokenCoverage=rows.some(r=>r.coverage==='known-subtotal')?'known-subtotal':'unknown';
 for(const a of activity){if(!jobs.has(a.jobId)||measured.has(a.jobId))throw new AppError('INVALID_INPUT','Измерение задания повторяется.');measured.add(a.jobId);summary.durationMs=sum(summary.durationMs??0,a.durationMs);}
 summary.measuredJobs=measured.size;summary.durationCoverage=measured.size?'partial':'unknown';
 for(const o of objects){if(physical.has(o.identity)&&physical.get(o.identity)!==o.size)throw new AppError('CONFLICT','Опись одного объекта противоречива.');physical.set(o.identity,o.size);}
 for(const size of physical.values())summary.knownBytesStored=sum(summary.knownBytesStored,size);if(completeInventory)summary.bytesStored=summary.knownBytesStored;
 return summary;
}
function canonical(value: unknown): unknown { if (Array.isArray(value))
    return value.map(canonical); if (record(value))
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
export const recoveryDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function parseCheckpointEvidence(value: unknown): CheckpointEvidence { if (!record(value) || value.version !== 1 || !record(value.checkpoint) || !record(value.state) || typeof value.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || typeof value.filesDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.filesDigest))
    throw new AppError('INVALID_INPUT', 'Свидетельство контрольной точки повреждено.'); const c = value.checkpoint, s = value.state; if (typeof c.id !== 'string' || typeof c.jobId !== 'string' || s.jobId !== c.jobId || typeof s.siteId !== 'string' || !Number.isSafeInteger(c.createdAt) || typeof c.stage !== 'string' || s.manifestId !== undefined && s.manifestId !== c.manifestId)
    throw new AppError('INVALID_INPUT', 'Привязка свидетельства повреждена.'); const digest = recoveryDigest([{ id: c.id, jobId: c.jobId, stage: c.stage, manifestId: c.manifestId, createdAt: c.createdAt }, s, value.sourceDigest, value.filesDigest]); if (digest !== value.digest)
    throw new AppError('INVALID_INPUT', 'Хэш свидетельства не совпадает.'); return value as unknown as CheckpointEvidence; }
export function projectCheckpoint(checkpoint: Checkpoint, state: Record<string, unknown>, files: ArtifactFile[], predecessor: string | null): CheckpointProjection {
    return projectCheckpointFromFileDigests(checkpoint,state,files.map(f=>({path:f.path,mediaType:f.mediaType,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')})),predecessor);
}
/** Pure projection; callers must establish each file digest from trusted immutable bytes. */
export function projectCheckpointFromFileDigests(checkpoint:Checkpoint,state:Record<string,unknown>,files:ReadonlyArray<{path:string;mediaType:string;size:number;sha256:string}>,predecessor:string|null):CheckpointProjection {
    if (state.jobId !== checkpoint.jobId || typeof state.siteId !== 'string')
        throw new AppError('INVALID_INPUT', 'Контрольная точка принадлежит другому заданию.');
    const safe: Record<string, unknown> = {};
    for (const key of ['schema', 'jobId', 'siteId', 'baseRevision', 'parentRevisionId', 'revisionId', 'manifestId', 'revisionCreatedAt', 'selection', 'validation', 'visualMap', 'visualProducer'])
        if (state[key] !== undefined)
            safe[key] = structuredClone(state[key]);
    const sourceDigest = createHash('sha256').update(JSON.stringify(state)).digest('hex'), filesDigest = recoveryDigest(files.map(f => [f.path, f.mediaType, f.size, f.sha256]));
    const semanticCheckpoint = { id: checkpoint.id, jobId: checkpoint.jobId, stage: checkpoint.stage, manifestId: checkpoint.manifestId, createdAt: checkpoint.createdAt };
    const evidence = { version: 1 as const, checkpoint: structuredClone(checkpoint), state: safe, sourceDigest, filesDigest, digest: recoveryDigest([semanticCheckpoint, safe, sourceDigest, filesDigest]) };
    const visual = record(state.visualProducer), records = [...(Array.isArray(state.transcript) ? state.transcript : []), ...(record(state.continuation) ? [state.continuation] : [])];
    let inputTokens = 0, outputTokens = 0, uncertainRequests = 0, requestPending = false, known = visual;
    for (const item of records)
        if (record(item)) {
            for (const key of ['inputTokens', 'outputTokens', 'uncertainRequests'] as const)
                if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0))
                    throw new AppError('INVALID_INPUT', 'Некорректный счётчик использования.');
            inputTokens += Number(item.inputTokens ?? 0);
            outputTokens += Number(item.outputTokens ?? 0);
            uncertainRequests += Number(item.uncertainRequests ?? 0);
            requestPending ||= item.requestPending === true;
            known ||= Number.isSafeInteger(item.inputTokens) && Number.isSafeInteger(item.outputTokens);
        }
    if (![inputTokens, outputTokens, uncertainRequests].every(Number.isSafeInteger))
        throw new AppError('INVALID_INPUT', 'Переполнение счётчика использования.');
    return { evidence, usage: { ...(record(state.imageRun)?{imagePending:state.imageRun.status==='pending'}:{}),version: 1, jobId: checkpoint.jobId, checkpointId: checkpoint.id, predecessor, inputTokens, outputTokens, uncertainRequests, requestPending, provenance: visual ? 'visual' : state.modelIdentity === 'demo' ? 'demo' : typeof state.modelIdentity === 'string' ? 'provider' : 'unknown', coverage: known ? 'known-subtotal' : 'unknown', durationMs: null, imageTokens: null }, execution: references(state, 'execution'), retained: references(state, 'retained') };
}
