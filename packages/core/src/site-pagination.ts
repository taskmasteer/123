import { AppError } from '../../contracts/src/model.js';
import type { Principal, SiteFilters } from '../../contracts/src/model.js';
export type { SiteFilters } from '../../contracts/src/model.js';
export function filterBinding(actor: Principal, filters: SiteFilters) { return JSON.stringify([actor.userId, actor.role, filters.domain ?? '', filters.status ?? '', filters.batchId ?? '']); }
export function siteFilters(value: SiteFilters = {}): SiteFilters {
    if (Object.keys(value).some(k => !['domain', 'status', 'batchId'].includes(k)) || Object.values(value).some(v => typeof v !== 'string' || v.length > 253))
        throw new AppError('INVALID_INPUT', 'Некорректный фильтр.');
    return { ...value, ...(value.domain ? { domain: value.domain.toLowerCase() } : {}) };
}
export function encodeCursor(key: string, binding: string) { return btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, key, binding })))); }
export function cursorShape(value: unknown): string {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
        return value;
    try {
        if (typeof value !== 'string' || value.length > 4000)
            throw new Error();
        const p = JSON.parse(decodeURIComponent(escape(atob(value)))) as Record<string, unknown>;
        if (Object.keys(p).sort().join(',') === 'binding,key,v' && p.v === 1 && typeof p.key === 'string' && p.key.length <= 100 && typeof p.binding === 'string' && p.binding.length <= 2000)
            return value;
    }
    catch { }
    throw new AppError('INVALID_INPUT', 'Некорректный курсор.');
}
export function decodeCursor(cursor: string | undefined, binding: string): string | undefined {
    if (cursor === undefined)
        return;
    try {
        const parsed = JSON.parse(decodeURIComponent(escape(atob(cursor)))) as {
            v: number;
            key: string;
            binding: string;
        };
        if (parsed.v === 1 && parsed.binding === binding && typeof parsed.key === 'string')
            return parsed.key;
    }
    catch { }
    throw new AppError('INVALID_INPUT', 'Курсор относится к другому фильтру или пользователю.');
}
/** Page-only byte budget; callers retain the entire record and advance after the last returned item. */
export function sitePagePrefix<T>(rows: T[], project: (row: T) => unknown, limit: number) {
    let bytes = 10000;
    const result: T[] = [];
    for (const row of rows.slice(0, limit)) {
        const size = new TextEncoder().encode(JSON.stringify(project(row))).length;
        if (bytes + size > 1000000) {
            if (!result.length)
                throw new AppError('INVALID_INPUT', 'Сохранённая запись превышает размер страницы.');
            break;
        }
        bytes += size;
        result.push(row);
    }
    return result;
}
