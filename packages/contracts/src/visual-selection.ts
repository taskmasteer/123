import type { Selection, Projection } from './visual.js';
export interface SelectionSession {
    sessionId: string;
    token: string;
    projection: Projection;
    sequence: number;
    active: boolean;
}
/** A read-only result can update an inspector; it has no save/native dispatch capability. */
export function acceptSelection(value: unknown, session: SelectionSession, source: unknown, expectedSource: unknown): Selection | null {
    if (!session.active || source !== expectedSource || !value || typeof value !== 'object' || Array.isArray(value))
        return null;
    let size: number;
    try {
        size = JSON.stringify(value).length;
    }
    catch {
        return null;
    }
    if (size > 2048)
        return null;
    const v = value as Selection;
    if (Object.keys(v).sort().join(',') !== 'documentPath,elementId,mapId,revisionId,sequence,sessionId,token,version' || v.version !== 1 || v.sessionId !== session.sessionId || v.token !== session.token || v.mapId !== session.projection.binding.mapId || v.revisionId !== session.projection.binding.revisionId || !Number.isSafeInteger(v.sequence) || v.sequence <= session.sequence || !session.projection.elements.some(e => e.elementId === v.elementId && e.documentPath === v.documentPath))
        return null;
    session.sequence = v.sequence;
    return v;
}
