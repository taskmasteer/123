import { AppError } from '../../contracts/src/model.js';
import type { Principal } from '../../contracts/src/model.js';
import type { SourceAccess, PublicationOutcome, HistoryEntry } from '../../contracts/src/recovery.js';
import { artifactPath, checkArtifacts } from './artifacts.js';
import { retainedOutcomes } from './retention.js';
export function historyEntries(outcomes: PublicationOutcome[], current: string | null, available: (manifestId: string) => boolean): HistoryEntry[] { const times = new Map<number, number>(); for (const o of outcomes)
    if (o.sequence === undefined)
        times.set(o.settledAt, (times.get(o.settledAt) ?? 0) + 1); const kept = retainedOutcomes(outcomes, current), retained = new Set(kept.map(o => o.id)), currentId = kept.find(o => o.settlement === 'settled' && o.revisionId === current)?.id; return [...outcomes].sort((a, b) => Number(b.settlement !== 'settled') - Number(a.settlement !== 'settled') || (b.sequence ?? 0) - (a.sequence ?? 0) || b.settledAt - a.settledAt || b.id.localeCompare(a.id)).map(o => ({ ...o, orderingUncertain: o.sequence === undefined && (times.get(o.settledAt) ?? 0) > 1, available: available(o.manifestId), current: o.id === currentId, retained: retained.has(o.id) })); }
export function createSourceFiles(access: SourceAccess) {
    async function files(actor: Principal, siteId: string, revisionId: string) { await access.admin(actor); const r = await access.revision(siteId, revisionId); if (!r || r.siteId !== siteId)
        throw new AppError('NOT_FOUND', 'Версия не найдена.'); const files = await access.read(r.manifestId); checkArtifacts(files); await access.admin(actor); return files; }
    return { async listSourceFiles(actor: Principal, siteId: string, revisionId: string) { return (await files(actor, siteId, revisionId)).map(f => ({ path: f.path, size: f.bytes.length })); },
        async readSourceFile(actor: Principal, siteId: string, revisionId: string, path: string) { artifactPath(path); const file = (await files(actor, siteId, revisionId)).find(f => f.path === path); if (!file)
            throw new AppError('NOT_FOUND', 'Файл не найден.'); return file; }, files };
}
