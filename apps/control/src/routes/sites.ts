import {sitePagePrefix,encodeCursor,filterBinding} from '../../../../packages/core/src/site-pagination.js';
import {registryProjection} from '../../../../packages/contracts/src/registry.js';
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
        const filters={ ...(url.searchParams.has('domain')?{domain:url.searchParams.get('domain')!}:{}),...(url.searchParams.has('status')?{status:url.searchParams.get('status')!}:{}),...(url.searchParams.has('batchId')?{batchId:uuid(url.searchParams.get('batchId'))}:{})};
        const list = await repo.list(actor, cursor ?? undefined, url.searchParams.has('limit') ? integer(Number(url.searchParams.get('limit')), 1, 100) : 50, { ...(url.searchParams.has('domain') ? { domain: url.searchParams.get('domain')! } : {}), ...(url.searchParams.has('status') ? { status: url.searchParams.get('status')! } : {}), ...(url.searchParams.has('batchId') ? { batchId: uuid(url.searchParams.get('batchId')) } : {}) });
        const rows=await repo.registryRows(list.items.map(s=>s.id));
        const all=list.items.map(s=>{const row=rows.get(s.id),j=row?.job??null;return siteView({...s,job:j?jobView(j):null,operation:row?.operation??null,registry:registryProjection(s,j,row?.state)});}),items=sitePagePrefix(all,s=>s,100);
        const key=items.at(-1)?.id,nextCursor=items.length<all.length&&key?(Object.values(filters).some(Boolean)?encodeCursor(key,filterBinding(actor,{...filters,...(filters.domain?{domain:filters.domain.toLowerCase()}:{})})):key):list.nextCursor;
        return {items,nextCursor};
    }
    const match = /^\/sites\/([^/]+)$/.exec(url.pathname);
    if (match && request.method === 'GET') {
        const s = await repo.scoped(actor, uuid(match[1]));
        const row=(await repo.registryRows([s.id])).get(s.id),job=row?.job??null;
        return siteView({ ...s, job: job ? jobView(job) : null,operation:row?.operation??null,registry:registryProjection(s,job,row?.state) });
    }
    return undefined;
}
