import { AppError, type AppErrorCode } from './model.js';
import { integer, object, string, uuid } from './http.js';
export const transferLimits = {
    raw: 1024 ** 2, json: 2 * 1024 ** 2, metadata: 256, resources: 64, record: 1000000, member: 32 * 1024 ** 2, staging: 64 * 1024 ** 2
} as const;
export interface RecoveryTransferBinding {
    version: 1;
    id: string;
    sourceId: string;
    records: number;
    digest: string;
}
export interface RecoveryTransferPart {
    seq: number;
    offset: number;
    size: number;
    sha256: string;
    base64: string;
    complete: boolean;
}
export interface RecoveryTransferBatch {
    binding: RecoveryTransferBinding;
    kind: 'metadata' | 'resources';
    cursor: string;
    digest: string;
    items: RecoveryTransferPart[];
}
export interface RecoveryTransferPage extends RecoveryTransferBatch {
    nextCursor: string | null;
    resourceCursor: string | null;
    expiresAt: number;
}
export interface RecoveryPreparationProgress {
    binding: RecoveryTransferBinding;
    phase: 'staging' | 'preparing' | 'validating' | 'ready' | 'committed' | 'cancelled' | 'failed';
    prepared: number;
    total: number;
    cursor: string;
    error?: {
        code: AppErrorCode;
        message: string;
    };
}
const invalid = (): never => { throw new AppError('INVALID_INPUT', 'Пакет восстановления повреждён или превышает лимит.'); };
export function recoveryDigest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    return invalid(); return value; }
export function transferBinding(value: unknown): RecoveryTransferBinding {
    const b = object(value, ['version', 'id', 'sourceId', 'records', 'digest']);
    if (b.version !== 1)
        return invalid();
    return {
        version: 1, id: uuid(b.id), sourceId: uuid(b.sourceId), records: integer(b.records, 1, 1000000), digest: recoveryDigest(b.digest)
    };
}
/** Fixed key order is the digest framing; expiry and credentials are deliberately excluded. */
export function batchContent(b: Omit<RecoveryTransferBatch, 'digest'>): string { return JSON.stringify({
    binding: transferBinding(b.binding), kind: b.kind, cursor: b.cursor, items: b.items.map(p => ({
        seq: p.seq, offset: p.offset, size: p.size, sha256: p.sha256, base64: p.base64, complete: p.complete
    }))
}); }
export function transferCursor(b: RecoveryTransferBinding, kind: 'metadata' | 'resources', seq: number, offset = 0, end = b.records): string { return `1:${b.digest}:${kind === 'metadata' ? 'm' : 'r'}:${seq}:${offset}:${end}`; }
export function transferBatch(value: unknown, page = false): RecoveryTransferBatch {
    const b = object(value, ['binding', 'kind', 'cursor', 'digest', 'items', ...(page ? ['nextCursor', 'resourceCursor', 'expiresAt'] : [])]);
    const binding = transferBinding(b.binding), kind = b.kind;
    if (kind !== 'metadata' && kind !== 'resources' || !Array.isArray(b.items) || !b.items.length || b.items.length > (kind === 'metadata' ? transferLimits.metadata : transferLimits.resources))
        return invalid();
    let raw = 0;
    const items = b.items.map(value => {
        const p = object(value, ['seq', 'offset', 'size', 'sha256', 'base64', 'complete']);
        const seq = integer(p.seq, 0, binding.records - 1), offset = integer(p.offset, 0, transferLimits.member), size = integer(p.size, 0, kind === 'metadata' ? transferLimits.record : transferLimits.member);
        if (typeof p.base64 !== 'string' || p.base64.length > Math.ceil(transferLimits.raw / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.base64) || typeof p.complete !== 'boolean')
            return invalid();
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        if (p.base64.endsWith('==') && (alphabet.indexOf(p.base64.at(-3)!) & 15) !== 0 || p.base64.endsWith('=') && !p.base64.endsWith('==') && (alphabet.indexOf(p.base64.at(-2)!) & 3) !== 0)
            return invalid();
        const length = p.base64.length / 4 * 3 - (p.base64.endsWith('==') ? 2 : p.base64.endsWith('=') ? 1 : 0);
        raw += length;
        if (raw > transferLimits.raw || offset + length > size || p.complete !== (offset + length === size) || (!length && size !== 0))
            return invalid();
        return {
            seq, offset, size, sha256: recoveryDigest(p.sha256), base64: p.base64, complete: p.complete
        };
    });
    const result: RecoveryTransferBatch = {
        binding, kind: kind as RecoveryTransferBatch['kind'], cursor: string(b.cursor, 1024), digest: recoveryDigest(b.digest), items
    };
    if (new TextEncoder().encode(JSON.stringify(value)).length > transferLimits.json)
        return invalid();
    return result;
}
export function transferPage(value: unknown): RecoveryTransferPage {
    const batch = transferBatch(value, true), p = value as Record<string, unknown>;
    return {
        ...batch, nextCursor: p.nextCursor === null ? null : string(p.nextCursor, 1024), resourceCursor: p.resourceCursor === null ? null : string(p.resourceCursor, 1024), expiresAt: integer(p.expiresAt)
    };
}
export function transferProgress(value: unknown): RecoveryPreparationProgress {
    const p = object(value, ['binding', 'phase', 'prepared', 'total', 'cursor']);
    if (!['staging', 'preparing', 'validating', 'ready', 'committed', 'cancelled', 'failed'].includes(String(p.phase)))
        return invalid();
    return {
        binding: transferBinding(p.binding), phase: p.phase as RecoveryPreparationProgress['phase'], prepared: integer(p.prepared, 0, 1000000), total: integer(p.total, 1, 1000000), cursor: string(p.cursor, 1024)
    };
}
