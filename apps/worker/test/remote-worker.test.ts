import { test, expect } from 'vitest';
import { createRemoteWorker } from '../src/remote-worker.js';
import type { WorkerDeps } from '../src/pipeline.js';
import { randomUUID } from 'node:crypto';
test('remote queue binds worker identity, rejects redirects and validates claimed job before exposing it', async () => {
    const workerId = randomUUID(), jobId = randomUUID(), requests: {
        url: string;
        init: RequestInit;
    }[] = [];
    const job = { id: jobId, siteId: randomUUID(), kind: 'generate', stage: 'brief', state: 'running', checkpointId: null, baseRevision: 0 };
    let response: unknown = { job, lease: { jobId, workerId, generation: 1, expiresAt: Date.now() + 120000 } };
    const transport = (async (url, init) => { requests.push({ url: String(url), init: init! }); return Response.json(response); }) as typeof fetch;
    const local = {} as WorkerDeps;
    const remote = createRemoteWorker({ controlOrigin: 'https://control.test', workerId, workerToken: 'private-worker', fetch: transport }, local);
    const claimed = await remote.queue.claim(workerId);
    expect(claimed?.job.id).toBe(jobId);
    expect(requests[0]!.url).toBe('https://control.test/worker/jobs/claim');
    expect(requests[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({});
    response = { job: { ...job, checkpointId: 7 }, lease: { jobId, workerId, generation: 1, expiresAt: 120000 } };
    await expect(remote.queue.claim(workerId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(remote.queue.claim(randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(() => createRemoteWorker({ controlOrigin: 'https://control.test/foreign', workerId, workerToken: 'private-worker' }, local)).toThrow();
});
