import { cursorShape } from '../../../packages/core/src/site-pagination.js';
import { importMethods } from '../../../packages/contracts/src/import.js';
import { importParams } from '../../../packages/contracts/src/import-wire.js';
import { visualMethods,visualParams } from '../../../packages/contracts/src/visual-wire.js';
import { AppError } from '../../../packages/contracts/src/model.js';
import { parseSiteInput, record } from '../../../packages/contracts/src/inputs.js';
import { validateModelConfig } from '../../../packages/adapters/src/openai/responses.js';
import type { ResponsesConfig } from '../../../packages/adapters/src/openai/responses.js';
export type PrivateModelConfiguration = {
    mode: 'demo' | 'blocked';
} | ({
    mode: 'live';
} & ResponsesConfig);
/** Only the private Rust pipe calls this parser; never part of renderer dispatch. */
export function parseModelConfiguration(value: unknown): PrivateModelConfiguration {
    if (!record(value) || !['demo', 'live', 'blocked'].includes(String(value.mode)) || Object.keys(value).some(key => !(value.mode === 'live' ? ['mode', 'apiKey', 'model', 'imageModel'] : ['mode']).includes(key)))
        throw new AppError('INVALID_INPUT', 'Invalid private model configuration.');
    if (value.mode === 'live')
        validateModelConfig(value as unknown as ResponsesConfig);
    return value as PrivateModelConfiguration;
}
export interface DesktopRequest {
    id: string;
    version: 1;
    method: string;
    params: Record<string, unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const methods: Record<string, string[]> = {
    ...importMethods,
    ...visualMethods,
    'site.list': ['cursor', 'limit', 'domain', 'status', 'batchId'], 'site.create': ['domain', 'about', 'referenceId'], 'job.status': ['siteId'],
    'job.retry': ['siteId'], 'preview.open': ['siteId', 'revisionId'], 'preview.screenshot': ['siteId', 'revisionId', 'width', 'candidateId'],
    'device.status': [], 'catalog.list': [], 'catalog.style.update': ['id', 'enabled'], 'catalog.reference.update': ['id', 'description'],
    'edit.request': ['siteId', 'instruction', 'expectedRevision', 'candidateId'],
    'edit.accept': ['siteId', 'candidateId', 'expectedRevision'], 'edit.reject': ['siteId', 'candidateId'],
    'edit.list': ['siteId'], 'chat.list': ['siteId'], 'site.publish': ['siteId', 'expectedRevision'],
};
export function parseDesktopRequest(value: unknown): DesktopRequest {
    const invalid = () => { throw new AppError('INVALID_INPUT', 'Unsupported or malformed desktop request.'); };
    if (!record(value) || Object.keys(value).some(k => !['id', 'version', 'method', 'params'].includes(k)) ||
        typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.id) || value.version !== 1 ||
        typeof value.method !== 'string' || !Object.hasOwn(methods, value.method) || !record(value.params))
        return invalid();
    const p = value.params, allowed = methods[value.method]!;
    if (Object.keys(p).some(k => !allowed.includes(k)))
        return invalid();
    if (Object.hasOwn(importMethods, value.method)) {
        importParams(value.method, p);
        return value as unknown as DesktopRequest;
    }
    if(Object.hasOwn(visualMethods,value.method)){visualParams(value.method,p);return value as unknown as DesktopRequest;}
    if (value.method === 'site.list') {
        if (p.cursor !== undefined)
            cursorShape(p.cursor);
        for (const k of ['domain', 'status'])
            if (p[k] !== undefined && (typeof p[k] !== 'string' || (p[k] as string).length > 253))
                return invalid();
        if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100))
            return invalid();
        if (p.batchId !== undefined && (typeof p.batchId !== 'string' || !uuid.test(p.batchId)))
            return invalid();
    }
    if (value.method === 'site.create') {
        parseSiteInput(p);
        if ((p.domain as string).length > 253 || (typeof p.about === 'string' && p.about.length > 8000) || (p.referenceId !== undefined && (typeof p.referenceId !== 'string' || p.referenceId.length > 100)))
            return invalid();
    }
    else if (value.method.startsWith('edit.') || value.method === 'chat.list' || value.method === 'site.publish') {
        if (typeof p.siteId !== 'string' || !uuid.test(p.siteId))
            return invalid();
        if (['edit.request', 'edit.accept', 'site.publish'].includes(value.method) && (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number) < 0))
            return invalid();
        if ((['edit.accept', 'edit.reject'].includes(value.method) || p.candidateId !== undefined) && (typeof p.candidateId !== 'string' || !uuid.test(p.candidateId)))
            return invalid();
        if (value.method === 'edit.request' && (typeof p.instruction !== 'string' || !p.instruction.trim() || p.instruction.length > 8000))
            return invalid();
    }
    else if (value.method.startsWith('job.') || value.method.startsWith('preview.')) {
        if (typeof p.siteId !== 'string' || !uuid.test(p.siteId))
            return invalid();
        if (value.method.startsWith('preview.') && (typeof p.revisionId !== 'string' || !uuid.test(p.revisionId)))
            return invalid();
        if (value.method === 'preview.screenshot' && p.width !== 375 && p.width !== 1440)
            return invalid();
        if (p.candidateId !== undefined && (typeof p.candidateId !== 'string' || !uuid.test(p.candidateId)))
            return invalid();
    }
    else if (value.method.endsWith('.update')) {
        if (typeof p.id !== 'string' || !p.id || p.id.length > 100)
            return invalid();
        if (value.method === 'catalog.style.update' && typeof p.enabled !== 'boolean')
            return invalid();
        if (value.method === 'catalog.reference.update' && (typeof p.description !== 'string' || !p.description.trim() || p.description.length > 4000))
            return invalid();
    }
    return value as unknown as DesktopRequest;
}
