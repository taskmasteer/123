import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { retainedOutcomes, references } from '../src/retention.js';
import { projectCheckpoint,projectCheckpointFromFileDigests } from '../src/usage.js';
import type { PublicationOutcome } from '../../contracts/src/recovery.js';
it('counts six actual settled outcomes while preserving observed conflicts separately', () => {
    const outcomes: PublicationOutcome[] = Array.from({ length: 8 }, (_, i) => ({ id: String(i), siteId: 's', revisionId: 'r' + i, manifestId: 'm' + i, settledAt: i, verifiedAt: i, settlement: 'settled', origin: 'draft', mode: 'managed' }));
    expect(retainedOutcomes(outcomes, 'r7').map(x => x.id)).toEqual(['7', '6', '5', '4', '3', '2']);
    outcomes.push({ ...outcomes[0]!, id: 'conflict', verifiedAt: 10, settlement: 'conflict' });
    expect(retainedOutcomes(outcomes, 'r7').map(x => x.id)).toEqual(['7', '6', '5', '4', '3', '2', 'conflict']);
});
it('uses durable action order for tied external times and counts a return to old bytes as a distinct outcome', () => {
    const outcomes: PublicationOutcome[] = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, sequence: i + 1, siteId: 's', revisionId: 'r' + i, manifestId: 'm' + i, settledAt: 100, verifiedAt: 100, settlement: 'settled', origin: 'draft', mode: 'managed' }));
    outcomes.push({ ...outcomes[1]!, id: 'return', sequence: 9, origin: 'rollback' });
    expect(retainedOutcomes(outcomes, 'r1').map(o => o.id)).toEqual(['return', 'p7', 'p6', 'p5', 'p4', 'p3']);
    const ambiguous = outcomes.slice(0, 8).map(({ sequence, ...o }) => o);
    expect(retainedOutcomes(ambiguous, 'r7')).toHaveLength(8);
});
it('preserves cumulative continuation once and a minimal immutable evidence projection without replay', () => {
    const checkpoint = { id: 'cp', jobId: 'job', stage: 'completed', manifestId: 'out', stateKey: 'private', createdAt: 10 };
    const state = { jobId: 'job', siteId: 'site', revisionId: 'rev', baseRevision: 1, manifestId: 'out', modelIdentity: 'openai:model', selection: { seed: 1, styleId: 'style', templateVersion: '1' }, transcript: [{ inputTokens: 5, outputTokens: 2 }], continuation: { inputTokens: 12, outputTokens: 7, uncertainRequests: 1, requestPending: true, replay: 'PRIVATE' }, providerRecoveries: [{ checkpointId: 'old', inputTokens: 8 }], baseManifestId: 'base', validation: { ok: true, issues: [], screenshotIds: ['png'] } };
    const projection = projectCheckpoint(checkpoint, state, [], null);
    expect(projection.usage).toMatchObject({ inputTokens: 17, outputTokens: 9, uncertainRequests: 1, requestPending: true });
    expect(JSON.stringify(projection.evidence)).not.toContain('PRIVATE');
    expect(projection.retained).toContainEqual({ kind: 'screenshot', id: 'png' });
    expect(projection.execution).toContainEqual({ kind: 'checkpoint', id: 'old' });
    expect(references(state, 'retained')).not.toContainEqual({ kind: 'artifact', id: 'base' });
});

it('keeps byte-backed and immutable-digest checkpoint projections identical',()=>{
 const checkpoint={id:'cp',jobId:'j',stage:'completed',manifestId:'m',stateKey:'private/state',createdAt:17},state={jobId:'j',siteId:'s',manifestId:'m',modelIdentity:'demo',transcript:[{inputTokens:3,outputTokens:9}],validation:{ok:true,issues:[],screenshotIds:['image']}};
 const files=[{path:'index.html',mediaType:'text/html',bytes:Buffer.from('<h1>actual bytes</h1>')},{path:'assets/x.bin',mediaType:'application/octet-stream',bytes:Buffer.from([0,255,7])}];
 const digests=files.map(f=>({path:f.path,mediaType:f.mediaType,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')}));
 expect(projectCheckpointFromFileDigests(checkpoint,state,digests,null)).toEqual(projectCheckpoint(checkpoint,state,files,null));
 expect(projectCheckpointFromFileDigests(checkpoint,state,digests.slice().reverse(),null).evidence.digest).not.toBe(projectCheckpoint(checkpoint,state,files,null).evidence.digest);
});
