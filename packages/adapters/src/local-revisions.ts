import { AppError } from '../../contracts/src/model.js';
import type { Revision, RevisionRepository } from '../../contracts/src/model.js';
import { record } from '../../contracts/src/inputs.js';
import { openLocalDatabase, existingLocalDatabase, type LocalDatabase } from './local-database.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseRevision(value: unknown): Revision {
    if (!record(value) || typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.siteId !== 'string' || !uuid.test(value.siteId) ||
        typeof value.manifestId !== 'string' || !uuid.test(value.manifestId) || (value.parentId !== null && (typeof value.parentId !== 'string' || !uuid.test(value.parentId))) ||
        !['draft', 'candidate', 'published'].includes(String(value.kind)) || !Number.isSafeInteger(value.createdAt))
        throw new AppError('INVALID_INPUT', 'Invalid revision.');
    return { id: value.id, siteId: value.siteId, manifestId: value.manifestId, parentId: value.parentId as string | null, kind: value.kind as Revision['kind'], createdAt: value.createdAt as number };
}
/** Immutable local revision catalog. Site pointers always resolve through these records. */
export async function createLocalRevisions(directory: string, database?: LocalDatabase): Promise<RevisionRepository> {
    const run = async <T>(action: (db: LocalDatabase) => T) => {
        const shared = database ?? await existingLocalDatabase(directory), db = shared ?? await openLocalDatabase(directory);
        try {
            return action(db);
        }
        finally {
            if (!shared)
                await db.close();
        }
    };
    return {
        async put(value) {
            const next = parseRevision(value);
            await run(db => db.transaction(() => {
                const old = db.sql.prepare("select data from records where kind='revisions' and id=?").get(next.id);
                if (old) {
                    if (JSON.stringify(parseRevision(JSON.parse(String(old.data)))) !== JSON.stringify(next))
                        throw new AppError('CONFLICT', 'Revision records are immutable.');
                    return;
                }
                if (next.parentId) {
                    const p = db.sql.prepare("select site_id from records where kind='revisions' and id=?").get(next.parentId);
                    if (p?.site_id !== next.siteId)
                        throw new AppError('INVALID_INPUT', 'Revision parent must belong to the same site.');
                }
                db.sql.prepare('insert into records values(?,?,?,?)').run('revisions', next.id, next.siteId, JSON.stringify(next));
            }));
        },
        async get(id) {
            if (!uuid.test(id))
                throw new AppError('INVALID_INPUT', 'Invalid revision ID.');
            return run(db => { const r = db.sql.prepare("select data from records where kind='revisions' and id=?").get(id); return r ? parseRevision(JSON.parse(String(r.data))) : null; });
        }
    };
}
