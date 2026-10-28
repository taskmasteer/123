import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database, seedUsers, identities } from './database.js';
import { SupabaseRepository } from '../../packages/adapters/src/supabase-repository.js';
import { PostgresQueue } from '../../packages/adapters/src/postgres-queue.js';
import { R2Store, type ObjectTransport } from '../../packages/adapters/src/r2-store.js';
import { PostgresBackup } from '../../packages/adapters/src/postgres-backup.js';
import { PostgresPublication } from '../../packages/adapters/src/postgres-publication.js';
import { VercelClient } from '../../packages/adapters/src/vercel/client.js';
import { manifestHash, publisherPolicyVersion, publisherConfiguration, digest } from '../../packages/core/src/publication.js';
import { createApp } from '../../apps/control/src/app.js';
class Objects implements ObjectTransport {
    data = new Map<string, Uint8Array>();
    async signPut(k: string) { return 'https://fixture.test/' + k; }
    async put(k: string, b: Uint8Array) { this.data.set(k, b); }
    async get(k: string) { return this.data.get(k)!; }
    async head(k: string) { return { size: this.data.get(k)!.length, mediaType: 'text/html' }; }
}
it.each(['settled', 'cancelled', 'ambiguous', 'forged', 'stale', 'role-loss', 'account-drift', 'unattached'])('read-only recovery reconciliation %s preserves source evidence, scope and provider exclusions until exact terminal proof', async (mode) => {
    const pool = await database();
    await seedUsers(pool);
    const repo = new SupabaseRepository(pool), queue = new PostgresQueue(repo), store = new R2Store(repo, new Objects(), queue), actor = { userId: identities.admin, role: 'admin' as const }, site = await repo.create({ domain: 'reconcile.example' }, actor), manifest = await store.put(site.id, [{ path: 'index.html', mediaType: 'text/html', bytes: Buffer.from('<h1>Frozen original</h1>') }], '1.0.0'), revision = { id: randomUUID(), siteId: site.id, parentId: null, manifestId: manifest.id, kind: 'candidate', createdAt: 1 }, id = randomUUID(), journal = randomUUID(), restoreId = randomUUID(), sourceEvidence = mode === 'cancelled' ? null : { verifiedAt: 99, providerTarget: 'original source evidence' }, calls: {
        method: string;
        path: string;
    }[] = [];
    try {
        await repo.transaction(async (tx) => { await tx.query("update private.jobs set data=jsonb_set(data,'{state}','\"completed\"') where id=$1", [site.id]); await tx.query("insert into public.revisions values($1,$2,null,$3,'candidate',1)", [revision.id, site.id, manifest.id]); await tx.query('update public.sites set draft_id=$2,revision=1 where id=$1', [site.id, revision.id]); await tx.query('insert into private.deployments values($1,$2,$3)', [journal, site.id, { id: journal, siteId: site.id, revisionId: revision.id, manifestId: manifest.id, expectedRevision: 1, state: 'pending' }]); await tx.query('insert into private.publication_reservations(id,site_id,request_key,binding,origin_controller_id) values($1,$2,$3,$4,$5)', [id, site.id, journal, { revisionId: revision.id, manifestId: manifest.id, expectedRevision: 1 }, randomUUID()]); await tx.query("insert into private.site_operations(site_id,operation_id,kind) values($1,$2,'publication') on conflict(site_id) do update set operation_id=excluded.operation_id,kind='publication',generation=null,expires_at=null", [site.id, id]); await tx.query("insert into private.provider_accounts(id,active_intent) values('team_fixture',$1)", [id]); if (mode !== 'unattached')
            await tx.query("insert into private.provider_publications(id,site_id,revision_id,manifest_id,manifest_hash,account_id,editing_intent_id,deployment_id,phase,data,evidence,verified_at) values($1,$2,$3,$4,$5,'team_fixture',$6,$7,'reconciling',$8,$9,$10)", [id, site.id, revision.id, manifest.id, manifestHash(manifest), journal, mode === 'ambiguous' ? null : 'dpl_fixture', { projectId: 'prj_fixture', projectName: 'sf-' + site.id, domain: site.domain, revision, policyVersion: publisherPolicyVersion, policyHash: digest(publisherConfiguration.bytes), action: 'find', dispatched: true }, sourceEvidence, sourceEvidence ? 99 : null]); await tx.query('insert into private.recovery_state values($1,$2)', ['installation', { restoreId, sourceId: 'original' }]); await tx.query('insert into private.recovery_state values($1,$2)', ['quarantine', { restoreId, sourceId: 'original' }]); });
        const deployment = { id: 'dpl_fixture', projectId: 'prj_fixture', meta: { sfIntent: id, sfSite: site.id, sfRevision: revision.id, sfManifest: manifestHash(manifest) }, readyState: mode === 'cancelled' ? 'CANCELED' : 'READY' }, client = new VercelClient({ token: 'fixture', accountId: 'team_fixture', fetch: async (input, init) => { const url = new URL(String(input)); calls.push({ method: init!.method!, path: url.pathname }); expect(init!.method).toBe('GET'); if (url.pathname.startsWith('/v2/teams/'))
                return Response.json({ id: 'team_fixture' }); if (url.pathname.startsWith('/v9/projects/'))
                return Response.json({ id: 'prj_fixture', name: 'sf-' + site.id, accountId: 'team_fixture', framework: null, buildCommand: '', installCommand: '' }); if (url.pathname === '/v7/deployments')
                return Response.json({ deployments: [deployment, { ...deployment, id: 'dpl_other' }], pagination: { next: null } }); if (url.pathname.startsWith('/v13/deployments/'))
                return Response.json(deployment); if (url.pathname.startsWith('/v4/aliases/'))
                return mode === 'cancelled' ? new Response(null, { status: 404 }) : Response.json({ alias: site.domain, projectId: 'prj_fixture', deploymentId: 'dpl_fixture' }); throw new Error('No provider mutation or unknown route permitted'); } }), publication = new PostgresPublication(queue, store, client, async () => { if (mode === 'stale')
            await repo.transaction(async (tx) => { await tx.query("select set_config('site_factory.restore','1',true)"); await tx.query('update public.sites set revision=2 where id=$1', [site.id]); }); if (mode === 'role-loss')
            await pool.query("update public.memberships set role='user' where user_id=$1", [actor.userId]); if (mode === 'account-drift')
            client.options.accountId = 'team_other'; return { verifiedAt: 12345 }; }), backup = new PostgresBackup(repo, store), app = createApp({ repository: repo, queue, store, publication, backup, auth: { verifyUser: async (token) => ({ userId: token === 'spec' ? identities.spec : identities.admin, role: token === 'spec' ? 'spec-user' : 'admin' }), verifyWorker: async () => { throw new Error('unused'); } } }), request = (path: string, body?: unknown, token = 'admin') => app(new Request('https://control.test' + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
        expect((await request('/admin/recovery/publications', undefined, 'spec')).status).toBe(403);
        const list = await (await request('/admin/recovery/publications')).json();
        expect(list.restoreId).toBe(restoreId);
        expect(list.items).toHaveLength(1);
        const body = { restoreId, id, digest: mode === 'forged' ? '0'.repeat(64) : list.items[0].digest, retiredSourceAuthority: true };
        expect((await request('/admin/recovery/reconcile', { ...body, evidence: { verified: true } })).status).toBe(400);
        const response = await request('/admin/recovery/reconcile', body), positive = ['settled', 'cancelled'].includes(mode);
        expect(response.status, await response.clone().text()).toBe(positive || ['ambiguous', 'unattached'].includes(mode) ? 200 : mode === 'role-loss' ? 403 : 409);
        if (positive) {
            expect(await response.json()).toEqual({ status: mode });
            const count = calls.length;
            expect(await (await request('/admin/recovery/reconcile', body)).json()).toEqual({ status: mode });
            expect(calls).toHaveLength(count);
            expect((await pool.query('select resolution from private.publication_reservations where id=$1', [id])).rows[0].resolution).toBe(mode);
            expect((await pool.query("select active_intent from private.provider_accounts where id='team_fixture'")).rows[0].active_intent).toBeNull();
            expect((await pool.query('select data from private.jobs where id=$1', [site.id])).rows[0].data.state).toBe('completed');
            if (mode === 'settled') {
                expect((await repo.get(site.id))!.publishedId).toBe(revision.id);
                expect((await pool.query('select evidence,verified_at from private.provider_publications where id=$1', [id])).rows[0]).toMatchObject({ evidence: sourceEvidence, verified_at: '99' });
            }
            expect((await request('/admin/recovery/release', { retiredSourceAuthority: true })).status).toBe(200);
        }
        else {
            if (response.status === 200)
                expect((await response.json()).status).toBe('manual-required');
            expect((await pool.query('select resolution from private.publication_reservations where id=$1', [id])).rows[0].resolution).toBeNull();
            expect((await pool.query("select active_intent from private.provider_accounts where id='team_fixture'")).rows[0].active_intent).toBe(id);
            expect((await repo.get(site.id))!.publishedId).toBeNull();
            expect((await pool.query("select 1 from private.recovery_state where key='quarantine'")).rowCount).toBe(1);
        }
        expect(calls.every(call => call.method === 'GET' && !call.path.includes('promote') && !call.path.includes('/files'))).toBe(true);
    }
    finally {
        await pool.end();
    }
});
