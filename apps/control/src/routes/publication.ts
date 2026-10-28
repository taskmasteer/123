import { AppError, type Principal } from '../../../../packages/contracts/src/model.js';
import { object, uuid, integer } from '../../../../packages/contracts/src/http.js';
import type { PostgresPublication } from '../../../../packages/adapters/src/postgres-publication.js';
export async function publicationRoute(publication: PostgresPublication | undefined, actor: Principal, request: Request, path: string, body: unknown) {
    const match = /^\/sites\/([^/]+)\/(publication|publication-history|domain-setup)(?:\/(resume))?$/.exec(path);
    if (!match)
        return undefined;
    if (!publication)
        throw new AppError('UNAVAILABLE', 'Публикация не настроена на сервере.');
    const siteId = uuid(match[1]), repo = publication.repo;
    await repo.transaction(async (tx) => { const fresh = await repo.fresh(tx, actor); await repo.scoped(fresh, siteId); });
    if (request.method === 'GET' && !match[3]) {
        if (match[2] === 'domain-setup')
            return publication.getDomainSetup(siteId);
        if (match[2] === 'publication-history')
            return publication.history(siteId);
        return { publication: await publication.latest(siteId), domain: await publication.getDomainSetup(siteId) };
    }
    if (request.method === 'POST' && match[2] === 'publication') {
        if (match[3] === 'resume') {
            const p = object(body, ['id']), id = uuid(p.id);
            await publication.authorizeResume(actor, siteId, id);
            await publication.advancePublication(id);
            return publication.view(id);
        }
        const p = object(body, ['revisionId', 'expectedRevision', 'requestKey']);
        return publication.requestPublication(actor, siteId, uuid(p.revisionId), integer(p.expectedRevision), uuid(p.requestKey));
    }
    throw new AppError('NOT_FOUND', 'Маршрут публикации не найден.');
}
