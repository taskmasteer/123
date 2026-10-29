import { it, expect } from 'vitest';
import { summarizeUsage } from '../src/usage.js';
import { nextActivity } from '../src/activity.js';
it('counts latest distinct jobs conservatively and physical identities rather than hashes or references', () => {
    const u = { version: 1 as const, jobId: 'job', checkpointId: 'latest', predecessor: 'old', inputTokens: 12, outputTokens: 8, uncertainRequests: 2, requestPending: true, provenance: 'provider' as const, coverage: 'known-subtotal' as const, durationMs: null, imageTokens: null };
    const a = { jobId: 'job', durationMs: 123, coverage: 'partial' as const, generation: null, sequence: null, fingerprint: null };
    const objects = [{ identity: 'bucket/key', size: 10 }, { identity: 'bucket/key', size: 10 }, { identity: 'bucket/other', size: 10 }];
    expect(summarizeUsage(['job', 'missing'], [u], [a], objects, false)).toMatchObject({ jobs: 2, missingJobs: 1, inputTokens: 12, outputTokens: 8, uncertainRequests: 2, requestPending: true, durationMs: 123, durationCoverage: 'partial', bytesStored: null, knownBytesStored: 20, estimatedCostUsd: null, imageTokens: null });
    expect(summarizeUsage(['missing'], [], [], [], false)).toMatchObject({ durationMs: null, bytesStored: null, tokenCoverage: 'unknown' });
    expect(() => summarizeUsage(['job'], [u, u], [], [], true)).toThrow();
    expect(() => summarizeUsage([], [], [], [{ identity: 'x', size: 1 }, { identity: 'x', size: 2 }], true)).toThrow();
});
it('compacts activity windows with contiguous idempotence and preserves subtotal across generations', () => {
    const a = nextActivity(null, 'job', 1, { sequence: 1, durationMs: 30 });
    expect(a.durationMs).toBe(30);
    expect(nextActivity(a, 'job', 1, { sequence: 1, durationMs: 30 })).toEqual(a);
    expect(() => nextActivity(a, 'job', 1, { sequence: 1, durationMs: 31 })).toThrow();
    expect(() => nextActivity(a, 'job', 1, { sequence: 3, durationMs: 20 })).toThrow();
    const b = nextActivity(a, 'job', 2, { sequence: 1, durationMs: 20 });
    expect(b.durationMs).toBe(50);
    expect(() => nextActivity(b, 'job', 1, { sequence: 2, durationMs: 1 })).toThrow();
});
