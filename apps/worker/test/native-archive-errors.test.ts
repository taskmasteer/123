import { it, expect, vi } from 'vitest';
import { NativeArchives, type NativeArchiveDeps } from '../src/native-archives.js';
import { randomUUID } from 'node:crypto';
const remote = { origin: 'https://configured.example', accessToken: 'session-token' };
function archives(response: () => Response) { return new NativeArchives({ native: true, fetch: async () => response() } as unknown as NativeArchiveDeps); }
it('propagates only bounded declared safe server errors and suppresses raw/unknown responses', async () => {
    const message = 'Для согласованной копии настройте DATABASE_CONNECTION_MODE: direct или session.';
    await expect((archives(() => Response.json({ error: { code: 'UNAVAILABLE', message }, requestId: randomUUID() }, { status: 503 })) as any).call(remote, '/admin/recovery/snapshots', {})).rejects.toMatchObject({ code: 'UNAVAILABLE', message });
    for (const value of [{ error: { code: 'P0001', message: 'raw database credential' }, requestId: randomUUID() }, { error: { code: 'UNAVAILABLE', message: 'raw stack', stack: 'secret' }, requestId: randomUUID() }, { error: { code: 'UNAVAILABLE', message: 'x'.repeat(1001) }, requestId: randomUUID() }, { provider: 'raw provider secret' }])
        await expect((archives(() => Response.json(value, { status: 503 })) as any).call(remote, '/admin/recovery/snapshots', {})).rejects.toThrow('Операция копии отклонена сервером (503).');
    await expect((archives(() => new Response('x'.repeat(64001), { status: 503 })) as any).call(remote, '/admin/recovery/snapshots', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('gives only exact snapshot POST a longer bounded issuance deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout'), instance = archives(() => Response.json({ ok: true }));
    try {
        await (instance as any).call(remote, '/admin/recovery/snapshots', {});
        expect(timeout).toHaveBeenLastCalledWith(180000);
        for (const [path, body] of [['/admin/recovery/snapshots', undefined], ['/admin/recovery/snapshots/other', {}], ['/admin/recovery/snapshots/id/record?seq=0', undefined]]) {
            await (instance as any).call(remote, path, body);
            expect(timeout).toHaveBeenLastCalledWith(30000);
        }
    }
    finally {
        timeout.mockRestore();
    }
});
