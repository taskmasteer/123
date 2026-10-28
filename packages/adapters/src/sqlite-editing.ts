import type { EditingState, EditingStore } from '../../contracts/src/editing.js';
import { parseEditingState } from '../../contracts/src/editing.js';
import { AppError } from '../../contracts/src/model.js';
import type { LocalDatabase } from './local-database.js';
/** Callback work happens before the short SQL commit; no SQLite transaction spans an await. */
export function sqliteEditing(db: LocalDatabase, siteId?: string): EditingStore {
    let tail: Promise<unknown> = Promise.resolve();
    return { forSite: id => sqliteEditing(db, id), transaction(operation) {
            const work = tail.then(async () => {
                const records = db.sql.prepare('select kind,id,data from records where kind in (?,?,?)' + (siteId ? ' and site_id=?' : '') + ' order by rowid').all('candidates', 'messages', 'publications', ...(siteId ? [siteId] : []));
                const state: EditingState = { version: 1, candidates: [], messages: [], publications: [] };
                for (const r of records)
                    (state[r.kind as 'candidates'] as unknown[]).push(JSON.parse(String(r.data)));
                const result = await operation(state);
                if (result.value) {
                    const next = parseEditingState(result.value);
                    db.transaction(() => {
                        const current = db.sql.prepare('select kind,id,data from records where kind in (?,?,?)' + (siteId ? ' and site_id=?' : '') + ' order by rowid').all('candidates', 'messages', 'publications', ...(siteId ? [siteId] : []));
                        if (JSON.stringify(current) !== JSON.stringify(records))
                            throw new AppError('CONFLICT', 'Editing journal changed.');
                        for (const kind of ['candidates', 'messages', 'publications'] as const)
                            for (const r of next[kind]) {
                                if (siteId && r.siteId !== siteId)
                                    throw new AppError('FORBIDDEN', 'Journal belongs to another site.');
                                db.sql.prepare('insert into records values(?,?,?,?) on conflict(kind,id) do update set data=excluded.data').run(kind, r.id, r.siteId, JSON.stringify(r));
                            }
                    });
                }
                return result.result;
            });
            tail = work.catch(() => { });
            return work;
        } };
}
