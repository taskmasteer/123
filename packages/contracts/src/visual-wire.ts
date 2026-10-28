import { object, integer, string, uuid } from './http.js';
import { elementPatch } from './visual.js';
export const visualMethods: Record<string, string[]> = {
    'visual.projection': ['siteId', 'expectedRevision'], 'visual.projection.chunk': ['siteId', 'expectedRevision', 'mapId', 'index'],
    'visual.submit': ['siteId', 'expectedRevision', 'mapId', 'requestKey', 'patch'], 'visual.status': ['siteId', 'saveId'],
    'visual.selection.begin': ['size', 'sha256'], 'visual.selection.chunk': ['id', 'index', 'base64'], 'visual.selection.open': ['id', 'documentPath'],
    'visual.selection.status': ['sessionId'], 'visual.selection.close': ['sessionId'],
};
export function visualParams(method: string, value: unknown): Record<string, unknown> {
    const p = object(value, visualMethods[method] ?? []);
    if (method === 'visual.projection' || method === 'visual.projection.chunk' || method === 'visual.submit') {
        uuid(p.siteId);
        integer(p.expectedRevision);
    }
    if (method === 'visual.projection.chunk' || method === 'visual.submit')
        string(p.mapId, 160);
    if (method === 'visual.projection.chunk')
        integer(p.index, 0, 500);
    if (method === 'visual.submit') {
        elementPatch(p.patch);
        string(p.requestKey, 100);
    }
    if (method === 'visual.status') {
        uuid(p.siteId);
        uuid(p.saveId);
    }
    if (method === 'visual.selection.begin') {
        integer(p.size, 1, 12000000);
        if (!/^[a-f0-9]{64}$/.test(String(p.sha256)))
            throw new Error('Invalid projection hash');
    }
    if (method === 'visual.selection.chunk') {
        uuid(p.id);
        integer(p.index, 0, 500);
        string(p.base64, 32000);
    }
    if (method === 'visual.selection.open') {
        uuid(p.id);
        if (p.documentPath !== undefined)
            string(p.documentPath, 240);
    }
    if (method === 'visual.selection.status' || method === 'visual.selection.close')
        uuid(p.sessionId);
    return p;
}
export function visualResponse(method: string, value: unknown): unknown {
    if (method === 'visual.projection') {
        const p = object(value, ['mapId', 'sha256', 'size']);
        string(p.mapId, 160);
        integer(p.size, 1, 12000000);
        if (!/^[a-f0-9]{64}$/.test(String(p.sha256)))
            throw new Error('Invalid projection hash');
        return p;
    }
    if (method === 'visual.projection.chunk') {
        const p = object(value, ['base64']);
        string(p.base64, 32000);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(p.base64)))
            throw new Error('Invalid chunk');
        return p;
    }
    if (method === 'visual.submit' || method === 'visual.status') {
        const p = object(value, ['saveId', 'status', 'revision', 'error']);
        uuid(p.saveId);
        if (!['queued', 'running', 'checking', 'ready', 'accepted', 'conflict', 'failed', 'rejected', 'completed'].includes(String(p.status)))
            throw new Error('Invalid Save status');
        if (p.error !== undefined)
            string(p.error, 1000);
        if (p.revision !== undefined) {
            const r = object(p.revision, ['id', 'siteId', 'parentId', 'manifestId', 'kind', 'createdAt']);
            uuid(r.id);
            uuid(r.siteId);
            if (r.parentId !== null)
                uuid(r.parentId);
            uuid(r.manifestId);
            integer(r.createdAt);
            if (!['draft', 'candidate', 'published'].includes(String(r.kind)))
                throw new Error('Invalid Revision');
        }
        return p;
    }
    return value;
}
