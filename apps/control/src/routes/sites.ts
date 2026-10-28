import type { Principal } from '../../../../packages/contracts/src/model.js';
import { parseSiteInput } from '../../../../packages/contracts/src/inputs.js';
import { jobView, siteView, integer, uuid } from '../../../../packages/contracts/src/http.js';
import type { SupabaseRepository } from '../../../../packages/adapters/src/supabase-repository.js';
export async function sitesRoute(repo: SupabaseRepository, actor: Principal, request: Request, url: URL, body: unknown) {
    if (url.pathname === '/sites' && request.method === 'POST')
        return siteView({ ...await repo.create(parseSiteInput(body), actor), job: null });
    if (url.pathname === '/sites' && request.method === 'GET') {
        for (const key of url.searchParams.keys())
            if (!['cursor', 'limit', 'domain', 'status', 'batchId'].includes(key))
                throw new Error('Unexpected query');
        const cursor = url.searchParams.get('cursor');
        const list = await repo.list(actor, cursor ?? undefined, url.searchParams.has('limit') ? integer(Number(url.searchParams.get('limit')), 1, 100) : 50, { ...(url.searchParams.has('domain') ? { domain: url.searchParams.get('domain')! } : {}), ...(url.searchParams.has('status') ? { status: url.searchParams.get('status')! } : {}), ...(url.searchParams.has('batchId') ? { batchId: uuid(url.searchParams.get('batchId')) } : {}) });
        return { ...list, items: await Promise.all(list.items.map(async (s) => { const j = await repo.current(s.id); return siteView({ ...s, job: j ? jobView(j) : null }); })) };
    }
    const match = /^\/sites\/([^/]+)$/.exec(url.pathname);
    if (match && request.method === 'GET') {
        const s = await repo.scoped(actor, uuid(match[1]));
        const job = await repo.current(s.id);
        return siteView({ ...s, job: job ? jobView(job) : null });
    }
    return undefined;
}
