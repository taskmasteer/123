import { PostgresHealth, postgresUsage } from '../../../../packages/adapters/src/postgres-monitoring.js';
import type { SupabaseRepository } from '../../../../packages/adapters/src/supabase-repository.js';
import type { Principal } from '../../../../packages/contracts/src/model.js';
import { object, uuid, integer } from '../../../../packages/contracts/src/http.js';
import { healthCode } from '../../../../packages/contracts/src/monitoring.js';
export async function workerHealthRoute(repo: SupabaseRepository, workerId: string, path: string, body: unknown) { const health = new PostgresHealth(repo); if (path === '/worker/health/claim') {
    object(body, []);
    return health.claim(workerId);
} if (path === '/worker/health/complete') {
    const p = object(body, ['siteId', 'token', 'generation', 'code']);
    return health.complete(workerId, { siteId: uuid(p.siteId), token: uuid(p.token), generation: integer(p.generation, 1), code: healthCode(p.code) });
} return undefined; }
export async function healthRoute(repo: SupabaseRepository, actor: Principal, request: Request, path: string, body: unknown) {
    if (request.method !== 'GET')
        return undefined;
    if (path === '/usage') {
        object(body, []);
        return postgresUsage(repo, actor);
    }
    const route = /^\/sites\/([^/]+)\/(health|usage)$/.exec(path);
    if (!route)
        return undefined;
    const siteId = uuid(route[1]);
    await repo.scoped(actor, siteId);
    return route[2] === 'health' ? new PostgresHealth(repo).read(siteId, actor) : postgresUsage(repo, actor, siteId);
}
