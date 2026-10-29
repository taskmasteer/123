import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NativeArchives, type NativeArchiveDeps } from '../src/native-archives.js';
import { LocalRetention } from '../../../packages/adapters/src/local-retention.js';
import { existingLocalDatabase } from '../../../packages/adapters/src/local-database.js';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { directory, cleanDirectories } from './fixtures.js';
import { RemoteRecoveryTransfer } from '../src/remote-recovery-transfer.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import { transferBatch, transferCursor, type RecoveryTransferBinding } from '../../../packages/contracts/src/recovery-transfer.js';
it('accepts a bounded remote batch above IPC size while ordinary responses retain their limit', async () => {
    const instance = new NativeArchives({
        native: true, fetch: async () => Response.json({
            base64: 'a'.repeat(100000)
        })
    } as unknown as NativeArchiveDeps);
    const remote = {
        origin: 'https://control.test', accessToken: 'fixture'
    };
    await expect((instance as any).call(remote, `/admin/recovery/snapshots/${randomUUID()}/batch?cursor=start`)).resolves.toHaveProperty('base64');
    await expect((instance as any).call(remote, '/session')).rejects.toMatchObject({
        code: 'INVALID_INPUT'
    });
});
it('drains an admitted hourly maintenance continuation before closing persistence', async () => {
    let callback: (() => void) | undefined, entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => entered = r), held = new Promise<void>(r => release = r);
    const interval = globalThis.setInterval;
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
        if (ms === 3600000)
            callback = fn;
        return interval(fn, ms, ...args);
    }) as typeof setInterval);
    const root = await directory(), runtime = await createDesktopRuntime(root, resolve('.'), {
        native: true
    });
    const db = await existingLocalDatabase(root);
    const maintenance = vi.spyOn(LocalRetention.prototype, 'backfill').mockImplementation(async () => { entered(); await held; db!.sql.prepare('insert into metadata values(?,?)').run('maintenance-drained', 'yes'); });
    let closed = false;
    const close = db!.close.bind(db!);
    db!.close = async () => { closed = true; await close(); };
    let closing: Promise<void> | undefined;
    try {
        callback!();
        await started;
        closing = runtime.close();
        expect(runtime.close()).toBe(closing);
        await new Promise(setImmediate);
        expect(closed).toBe(false);
        release();
        await closing;
        expect(closed).toBe(true);
    }
    finally {
        release();
        await closing;
        await runtime.close();
        maintenance.mockRestore();
        timer.mockRestore();
        await cleanDirectories();
    }
});
it('refreshes only a server-verified stable session and keeps cached working status free of handle authority', async () => {
    const userId = randomUUID(), scope = 'a'.repeat(64);
    let allowed = true, reads = 0;
    const native = new NativeArchives({
        native: true, fetch: async () => {
            reads++;
            return Response.json({
                principal: {
                    userId, role: allowed ? 'admin' : 'user'
                }, capabilities: {
                    admin: allowed
                }
            }, {
                headers: {
                    'x-site-factory-session': scope
                }
            });
        }
    } as unknown as NativeArchiveDeps);
    const one = {
        origin: 'https://control.test', accessToken: 'one'
    }, two = {
        ...one, accessToken: 'two'
    }, context = await (native as any).context(one);
    const made = (native as any).start(context, async (op: any) => new Promise<void>(r => op.abort.signal.addEventListener('abort', () => r(), {
        once: true
    })));
    try {
        await native.request({
            action: 'status', id: made.id, remote: two
        });
        const op = (native as any).operations.get(made.id);
        expect(op.remote.accessToken).toBe('two');
        expect(op.sessionId).toBe(scope);
        const before = reads;
        allowed = false;
        expect(await native.request({
            action: 'status', id: made.id, remote: two
        })).toEqual({
            id: made.id, state: 'working'
        });
        expect(reads).toBe(before);
        await expect(native.request({
            action: 'save', id: made.id, remote: two, destination: 'unused'
        })).rejects.toMatchObject({
            code: 'FORBIDDEN'
        });
        expect(reads).toBe(before + 1);
        expect((native as any).operations.has(made.id)).toBe(false);
    }
    finally {
        await native.shutdown();
    }
});
it.each([true, false])('cancels rather than adopting a new session (stable claim present=%s)', async (stable) => {
    const userId = randomUUID();
    let scope = 'a'.repeat(64);
    const native = new NativeArchives({
        native: true, fetch: async () => Response.json({
            principal: {
                userId, role: 'admin'
            }, capabilities: {
                admin: true
            }
        }, {
            headers: stable ? {
                'x-site-factory-session': scope
            } : {}
        })
    } as unknown as NativeArchiveDeps);
    const remote = {
        origin: 'https://control.test', accessToken: 'one'
    }, context = await (native as any).context(remote);
    const made = (native as any).start(context, async (op: any) => new Promise<void>(r => op.abort.signal.addEventListener('abort', () => r(), {
        once: true
    })));
    try {
        scope = 'b'.repeat(64);
        await expect(native.request({
            action: 'status', id: made.id, remote: {
                ...remote, accessToken: 'two'
            }
        })).rejects.toMatchObject({
            code: 'UNAUTHENTICATED'
        });
        expect((native as any).operations.has(made.id)).toBe(false);
    }
    finally {
        await native.shutdown();
    }
});
it('limits all native HTTP requests to four with deterministic backpressure', async () => {
    let active = 0, maximum = 0;
    const releases: (() => void)[] = [];
    const native = new NativeArchives({
        native: true, fetch: async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise<void>(r => releases.push(r));
            active--;
            return Response.json({
                ok: true
            });
        }
    } as unknown as NativeArchiveDeps);
    const remote = {
        origin: 'https://control.test', accessToken: 'one'
    }, work = Array.from({
        length: 12
    }, () => (native as any).call(remote, '/session'));
    for (let wave = 0; wave < 3; wave++) {
        await new Promise(setImmediate);
        expect(releases.length).toBe(4);
        for (const r of releases.splice(0))
            r();
    }
    await Promise.all(work);
    expect(maximum).toBe(4);
});
it('retries only transient transport uncertainty three times without real sleeps', async () => {
    const delays: number[] = [];
    let calls = 0;
    const runner = new RemoteRecoveryTransfer(async () => {
        if (++calls < 4)
            throw new AppError('UNAVAILABLE', 'temporary');
        return {
            ok: true
        };
    }, 'unused', new AbortController().signal, async (ms) => { delays.push(ms); });
    await expect((runner as any).request('/fixed', {})).resolves.toEqual({
        ok: true
    });
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 500, 1500]);
    calls = 0;
    const forbidden = new RemoteRecoveryTransfer(async () => { calls++; throw new AppError('FORBIDDEN', 'denied'); }, 'unused', new AbortController().signal, async () => { });
    await expect((forbidden as any).request('/fixed', {})).rejects.toMatchObject({
        code: 'FORBIDDEN'
    });
    expect(calls).toBe(1);
});
it('rejects encoded/raw/count overflow and noncanonical base64 before a transfer is admitted', () => {
    const binding: RecoveryTransferBinding = {
        version: 1, id: randomUUID(), sourceId: randomUUID(), records: 1000, digest: 'a'.repeat(64)
    }, part = {
        seq: 0, offset: 0, size: 1, sha256: 'b'.repeat(64), base64: 'YQ==', complete: true
    }, base = {
        binding, kind: 'metadata', cursor: transferCursor(binding, 'metadata', 0), digest: 'c'.repeat(64), items: [part]
    };
    expect(() => transferBatch({
        ...base, items: Array(257).fill(part)
    })).toThrow();
    expect(() => transferBatch({
        ...base, items: [{
                ...part, base64: 'AB=='
            }]
    })).toThrow();
    const bytes = Buffer.alloc(1024 ** 2 + 1);
    expect(() => transferBatch({
        ...base, kind: 'resources', items: [{
                ...part, size: bytes.length, base64: bytes.toString('base64')
            }]
    })).toThrow();
});
it('accepts the exact1MiB raw resource packet without recursive Base64 validation', () => {
    const binding = {
        version: 1 as const, id: randomUUID(), sourceId: randomUUID(), records: 1, digest: 'a'.repeat(64)
    }, bytes = Buffer.alloc(1024 ** 2), batch = {
        binding, kind: 'resources' as const, cursor: transferCursor(binding, 'resources', 0), digest: 'b'.repeat(64), items: [{
                seq: 0, offset: 0, size: bytes.length, sha256: 'c'.repeat(64), base64: bytes.toString('base64'), complete: true
            }]
    };
    expect(transferBatch(batch).items[0]!.size).toBe(bytes.length);
});
it('joins an already admitted archive request during shutdown before reporting drained', async () => {
    const userId = randomUUID();
    let held = false, entered!: () => void, release!: () => void;
    const reached = new Promise<void>(r => entered = r), wait = new Promise<void>(r => release = r);
    const native = new NativeArchives({
        native: true, fetch: async () => {
            if (held) {
                entered();
                await wait;
            }
            return Response.json({
                principal: {
                    userId, role: 'admin'
                }, capabilities: {
                    admin: true
                }
            });
        }
    } as unknown as NativeArchiveDeps), remote = {
        origin: 'https://control.test', accessToken: 'fixture'
    }, context = await (native as any).context(remote), made = (native as any).start(context, async () => ({
        ok: true
    }));
    await (native as any).operations.get(made.id).work;
    held = true;
    const request = native.request({
        action: 'status', id: made.id, remote
    }).catch(() => { });
    await reached;
    let drained = false;
    const shutdown = native.shutdown().then(() => { drained = true; });
    try {
        await new Promise(setImmediate);
        expect(drained).toBe(false);
    }
    finally {
        release();
        await request;
        await shutdown;
    }
});
it.each([false, true])('keeps renewal outside an exact final commit (renewal admitted first=%s)', async (renewalFirst) => {
    const barrier = () => { let release!: () => void; return {
        wait: new Promise<void>(r => release = r), release: () => release()
    }; }, commitHeld = barrier(), renewHeld = barrier(), startCommit = barrier(), commitEntered = barrier(), renewEntered = barrier(), order: string[] = [];
    let clock = 0, tick: (() => void) | undefined;
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock), interval = globalThis.setInterval, timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number, ...args: any[]) => { if (ms === 30000)
        tick = fn; return interval(fn, ms, ...args); }) as typeof setInterval), userId = randomUUID(), id = randomUUID();
    const native = new NativeArchives({
        native: true, fetch: async (input:RequestInfo|URL) => { const path = new URL(String(input)).pathname; if (path.endsWith('/renew')) {
            order.push('renew');
            renewEntered.release();
            await renewHeld.wait;
            return Response.json({
                expiresAt: clock + 3600000
            });
        } if (path.endsWith('/commit')) {
            order.push('commit');
            commitEntered.release();
            await commitHeld.wait;
            return Response.json({
                ok: true
            });
        } return Response.json({
            principal: {
                userId, role: 'admin'
            }, capabilities: {
                admin: true
            }
        }); }
    } as unknown as NativeArchiveDeps), remote = {
        origin: 'https://control.test', accessToken: 'fixture'
    }, context = await (native as any).context(remote), made = (native as any).start(context, async (op: any) => { op.transferId = id; if (renewalFirst)
        await startCommit.wait; return (native as any).operationCall(op, '/admin/recovery/restores/' + id + '/commit', {}); }), op = (native as any).operations.get(made.id);
    try {
        await new Promise(setImmediate);
        clock = 31000;
        if (renewalFirst) {
            tick!();
            await renewEntered.wait;
            startCommit.release();
            await new Promise(setImmediate);
            expect(order.filter(x => x === 'commit')).toHaveLength(0);
            tick!();
            renewHeld.release();
            await commitEntered.wait;
            expect(order).toEqual(['renew', 'commit']);
        }
        else {
            await commitEntered.wait;
            tick!();
            await new Promise(setImmediate);
            expect(order).toEqual(['commit']);
        }
    }
    finally {
        startCommit.release();
        renewHeld.release();
        commitHeld.release();
        await op.work;
        await native.shutdown();
        timer.mockRestore();
        date.mockRestore();
    }
});
