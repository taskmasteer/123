import { AppError } from './model.js';
import { object, integer, string, uuid } from './http.js';
import { importMethods, importLimits } from './import.js';
export function importParams(method: string, value: unknown) {
    if (!Object.hasOwn(importMethods, method))
        throw new AppError('INVALID_INPUT', 'Неизвестная команда импорта.');
    const p = object(value, importMethods[method]!);
    if (!['resource.begin', 'batch.list'].includes(method))
        uuid(p.id);
    if (method === 'resource.begin') {
        string(p.name, 200);
        integer(p.size, 1, p.draftId ? 2000000 : importLimits.sourceBytes);
        if (!/^[a-f0-9]{64}$/.test(String(p.sha256)))
            throw new AppError('INVALID_INPUT', 'Некорректный хеш.');
        if (p.draftId !== undefined) {
            uuid(p.draftId);
            integer(p.rowNumber, 2, 5001);
            integer(p.revision);
        }
    }
    if (method === 'resource.chunk') {
        integer(p.index, 0, 699);
        const base64 = string(p.base64, 32000);
        try {
            if (btoa(atob(base64)) !== base64)
                throw new Error();
        }
        catch {
            throw new AppError('INVALID_INPUT', 'Некорректный фрагмент.');
        }
    }
    if (['import.update', 'batch.retry'].includes(method))
        integer(p.rowNumber, 2, 5001);
    if (['import.update', 'import.commit'].includes(method))
        integer(p.revision);
    if (method === 'import.commit')
        string(p.requestKey, 100);
    for (const field of ['domain', 'about', 'referenceId'] as const)
        if (p[field] !== undefined && (typeof p[field] !== 'string' || p[field].length > (field === 'domain' ? 253 : field === 'referenceId' ? 100 : 8000)))
            throw new AppError('INVALID_INPUT', 'Некорректное значение строки.');
    if (p.cursor !== undefined)
        string(p.cursor, 4000);
    if (p.status !== undefined && !['all', 'valid', 'invalid'].includes(String(p.status)))
        throw new AppError('INVALID_INPUT', 'Некорректный фильтр.');
    if (method === 'batch.assign') {
        if (!Array.isArray(p.userIds) || p.userIds.length > 100)
            throw new AppError('INVALID_INPUT', 'Некорректные назначения.');
        p.userIds.forEach(uuid);
    }
    return p;
}
function summary(value: unknown) {
    const p = object(value, ['id', 'name', 'revision', 'state', 'total', 'validCount', 'invalidCount', 'canControl', 'assignedUserIds']);
    uuid(p.id);
    if (p.assignedUserIds !== undefined) {
        if (!Array.isArray(p.assignedUserIds) || p.assignedUserIds.length > 100)
            throw new AppError('INVALID_INPUT', 'Некорректные назначения.');
        p.assignedUserIds.forEach(uuid);
    }
    string(p.name, 200);
    integer(p.revision);
    integer(p.total, 0, 5000);
    integer(p.validCount, 0, 5000);
    integer(p.invalidCount, 0, 5000);
    if (!['uploading', 'preview', 'active', 'paused', 'cancelled'].includes(String(p.state)) || typeof p.canControl !== 'boolean')
        throw new AppError('INVALID_INPUT', 'Некорректная пачка.');
    return p;
}
export function importResponse(method: string, value: unknown): unknown {
    if (method === 'resource.begin') {
        const p = object(value, ['id']);
        uuid(p.id);
        return p;
    }
    if (method === 'import.commit') {
        const p = object(value, ['batchId']);
        uuid(p.batchId);
        return p;
    }
    if (['import.prepare', 'import.update', 'logo.complete', 'batch.get'].includes(method))
        return summary(value);
    if (method === 'batch.list') {
        const p = object(value, ['items', 'nextCursor']);
        if (!Array.isArray(p.items) || p.items.length > 50)
            throw new AppError('INVALID_INPUT', 'Слишком большая страница.');
        p.items.forEach(summary);
        if (p.nextCursor !== null)
            string(p.nextCursor, 2000);
        return p;
    }
    if (method === 'batch.rows') {
        const p = object(value, ['items', 'nextCursor']);
        if (!Array.isArray(p.items) || p.items.length > importLimits.pageRows)
            throw new AppError('INVALID_INPUT', 'Слишком большая страница.');
        if (p.nextCursor !== null)
            string(p.nextCursor, 2000);
        for (const raw of p.items) {
            const r = object(raw, ['rowNumber', 'input', 'issues', 'siteId', 'job']);
            integer(r.rowNumber, 2, 5001);
            const input = object(r.input, ['rowNumber', 'domain', 'about', 'referenceId', 'logo', 'logoAssetId']);
            integer(input.rowNumber, 2, 5001);
            for (const [key, v] of Object.entries(input))
                if (key !== 'rowNumber' && (typeof v !== 'string' || v.length > 8000))
                    throw new AppError('INVALID_INPUT', 'Некорректная строка.');
            if (!Array.isArray(r.issues) || r.issues.length > 16)
                throw new AppError('INVALID_INPUT', 'Некорректные ошибки.');
            for (const raw of r.issues) {
                const i = object(raw, ['rowNumber', 'column', 'code', 'message']);
                integer(i.rowNumber, 2, 5001);
                string(i.column, 100);
                string(i.code, 100);
                string(i.message, 1000);
            }
            if (r.siteId !== null)
                uuid(r.siteId);
            if (r.job !== null) {
                const j = object(r.job, ['id', 'stage', 'state']);
                uuid(j.id);
                string(j.stage, 100);
                string(j.state, 100);
            }
        }
        return p;
    }
    const p = object(value, ['ok']);
    if (p.ok !== true)
        throw new AppError('INVALID_INPUT', 'Некорректный ответ.');
    return p;
}
