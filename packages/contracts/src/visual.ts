import { AppError } from './model.js';
import type { Revision } from './model.js';
export function screenshotIdentity(value: unknown): string {
    if (typeof value !== 'string' || !/^(?:validation\/)?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.png)?$/i.test(value) || (value.startsWith('validation/') !== value.endsWith('.png')))
        throw new AppError('INVALID_INPUT', 'Недопустимый снимок проверки.');
    return value;
}
export interface ElementPatch {
    elementId: string;
    text?: string;
    href?: string;
    imageAssetId?: string;
    styles?: {
        color?: string;
        backgroundColor?: string;
        fontSize?: string;
        margin?: string;
        padding?: string;
    };
}
export interface MapBinding {
    version: 1;
    siteId: string;
    revisionId: string;
    manifestId: string;
    lineage: string;
    mapId: string;
}
export interface VisualProducer {
    kind: 'visual';
    version: 1;
    binding: MapBinding;
    patch: ElementPatch;
}
export interface VisualSave {
    actorId: string;
    requestKey: string;
    payloadHash: string;
    state: 'pending' | 'completed' | 'failed';
    error?: string;
}
export interface EditableElement {
    elementId: string;
    documentPath: string;
    tag: string;
    fields: string[];
    text?: string;
    href?: string;
    styles?: ElementPatch['styles'];
}
export interface Projection {
    version: 1;
    binding: MapBinding;
    elements: EditableElement[];
    documents: {
        path: string;
        html: string;
    }[];
}
export interface Selection {
    version: 1;
    sessionId: string;
    token: string;
    mapId: string;
    revisionId: string;
    documentPath: string;
    elementId: string;
    sequence: number;
}
export interface SaveView {
    saveId: string;
    status: string;
    revision?: Revision;
    error?: string;
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function elementPatch(value: unknown): ElementPatch {
    const bad = () => { throw new AppError('INVALID_INPUT', 'Недопустимая визуальная правка.'); };
    if (!obj(value) || Object.keys(value).some(k => !['elementId', 'text', 'href', 'imageAssetId', 'styles'].includes(k)) || typeof value.elementId !== 'string' || !/^e_[a-f0-9]{64}$/.test(value.elementId))
        return bad();
    if (Object.keys(value).length < 2)
        return bad();
    for (const key of ['text', 'href', 'imageAssetId'])
        if (value[key] !== undefined && (typeof value[key] !== 'string' || (value[key] as string).length > ({ text: 8000, href: 2048, imageAssetId: 64 }[key]!) || /[\u0000\ud800-\udfff]/u.test((value[key] as string).replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))))
            return bad();
    if (value.imageAssetId !== undefined && !/^[0-9a-f-]{36}$/i.test(String(value.imageAssetId)))
        return bad();
    if (value.styles !== undefined && (!obj(value.styles) || !Object.keys(value.styles).length || Object.entries(value.styles).some(([k, v]) => !['color', 'backgroundColor', 'fontSize', 'margin', 'padding'].includes(k) || typeof v !== 'string' || !v || v.length > 128)))
        return bad();
    return value as unknown as ElementPatch;
}
export function mapBinding(value: unknown): MapBinding {
    if (!obj(value) || Object.keys(value).some(k => !['version', 'siteId', 'revisionId', 'manifestId', 'lineage', 'mapId'].includes(k)) || value.version !== 1 || !['siteId', 'revisionId', 'manifestId', 'lineage', 'mapId'].every(k => typeof value[k] === 'string' && (value[k] as string).length > 0 && (value[k] as string).length <= 160))
        throw new AppError('INVALID_INPUT', 'Недопустимая карта элементов.');
    return value as unknown as MapBinding;
}
export function validVisualProducer(value: unknown): value is VisualProducer {
    try {
        if (!obj(value) || Object.keys(value).sort().join(',') !== 'binding,kind,patch,version' || value.kind !== 'visual' || value.version !== 1)
            return false;
        mapBinding(value.binding);
        elementPatch(value.patch);
        return true;
    }
    catch {
        return false;
    }
}
