import { object, uuid, integer, string } from './http.js';
import { artifactPath } from '../../core/src/artifacts.js';
export const recoveryMethods: Record<string, string[]> = { 'site.history': ['siteId', 'offset'], 'site.rollback': ['siteId', 'revisionId', 'expectedRevision', 'requestKey'], 'source.list': ['siteId', 'revisionId'], 'source.read': ['siteId', 'revisionId', 'path', 'offset'], 'recovery.publications': ['offset'], 'recovery.reconcile': ['restoreId', 'id', 'digest', 'retiredSourceAuthority'], 'recovery.status': [], 'recovery.release': ['retiredSourceAuthority'] };
export function recoveryParams(method: string, value: unknown) { const p = object(value, recoveryMethods[method] ?? []); if (method.startsWith('recovery.')) {
    if (method === 'recovery.publications' && p.offset !== undefined)
        integer(p.offset, 0, 100000);
    if (method === 'recovery.reconcile') {
        uuid(p.restoreId);
        uuid(p.id);
        if (typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest))
            throw new Error('Invalid recovery binding');
    }
    if (p.retiredSourceAuthority !== undefined && typeof p.retiredSourceAuthority !== 'boolean')
        throw new Error('Invalid recovery confirmation');
    return p;
} uuid(p.siteId); if (method === 'site.history') {
    if (p.offset !== undefined)
        integer(p.offset, 0, 100000);
    return p;
} uuid(p.revisionId); if (method === 'site.rollback') {
    integer(p.expectedRevision);
    uuid(p.requestKey);
} if (method === 'source.read') {
    artifactPath(string(p.path, 240));
    if (p.offset !== undefined)
        integer(p.offset, 0, 2000000);
} return p; }
export function recoveryResponse(method: string, value: unknown) {
    if (method === 'source.list') {
        const p = object(value, ['files']);
        if (!Array.isArray(p.files) || p.files.length > 100)
            throw new Error('Invalid source tree');
        for (const raw of p.files) {
            const f = object(raw, ['path', 'size']);
            artifactPath(string(f.path, 240));
            integer(f.size, 0, 2000000);
        }
        return p;
    }
    if (method === 'source.read') {
        const p = object(value, ['path', 'mediaType', 'size', 'offset', 'base64', 'nextOffset']);
        artifactPath(string(p.path, 240));
        string(p.mediaType, 100);
        integer(p.size, 0, 2000000);
        integer(p.offset, 0, 2000000);
        const bytes = p.base64;
        if (typeof bytes !== 'string' || bytes.length > 32000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes))
            throw new Error('Invalid source chunk');
        const decoded = atob(bytes);
        if (btoa(decoded) !== bytes || Number(p.offset) > Number(p.size) || decoded.length !== Math.min(24000, Number(p.size) - Number(p.offset)))
            throw new Error('Invalid source chunk');
        const end = Number(p.offset) + decoded.length;
        if (p.nextOffset !== (end < Number(p.size) ? end : null))
            throw new Error('Invalid source chunk');
        return p;
    }
    if (method === 'site.history') {
        const p = object(value, ['items', 'nextOffset']);
        if (!Array.isArray(p.items) || p.items.length > 20)
            throw new Error('Invalid history page');
        for (const value of p.items) {
            const h = object(value, ['id', 'siteId', 'revisionId', 'manifestId', 'settledAt', 'verifiedAt', 'settlement', 'mode', 'current', 'retained', 'available', 'origin', 'sequence', 'orderingUncertain']);
            for (const key of ['id', 'siteId', 'revisionId', 'manifestId'])
                uuid(h[key]);
            integer(h.settledAt);
            if (h.sequence !== undefined)
                integer(h.sequence, 1);
            if (h.orderingUncertain !== undefined && typeof h.orderingUncertain !== 'boolean')
                throw new Error('Invalid ordering');
            if (h.verifiedAt !== null)
                integer(h.verifiedAt);
            if (!['settled', 'pending', 'conflict', 'cancelled'].includes(String(h.settlement)) || !['demo', 'managed'].includes(String(h.mode)) || ['current', 'retained', 'available'].some(k => typeof h[k] !== 'boolean'))
                throw new Error('Invalid history outcome');
        }
        if (p.nextOffset !== null)
            integer(p.nextOffset, 0, 100000);
        return p;
    }
    if (method === 'recovery.reconcile') {
        const p = object(value, ['status', 'reason']);
        if (!['settled', 'cancelled', 'manual-required'].includes(String(p.status)))
            throw new Error('Invalid recovery result');
        if (p.reason !== undefined)
            string(p.reason, 100);
        return p;
    }
    if (method === 'recovery.publications') {
        const p = object(value, ['restoreId', 'items', 'nextOffset', 'remaining']);
        integer(p.remaining, 0, 1000000);
        if (p.restoreId !== null)
            uuid(p.restoreId);
        if (!Array.isArray(p.items) || p.items.length > 20)
            throw new Error('Invalid recovery list');
        for (const raw of p.items) {
            const row = object(raw, ['id', 'siteId', 'domain', 'accountId', 'attached', 'digest']);
            uuid(row.id);
            uuid(row.siteId);
            string(row.domain, 253);
            if (row.accountId !== null)
                string(row.accountId, 100);
            if (typeof row.attached !== 'boolean' || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest))
                throw new Error('Invalid recovery proof binding');
        }
        if (p.nextOffset !== null)
            integer(p.nextOffset, 0, 100000);
        return p;
    }
    if (method === 'recovery.status') {
        const p = object(value, ['quarantined']);
        if (typeof p.quarantined !== 'boolean')
            throw new Error('Invalid recovery state');
        return p;
    }
    return value;
}
