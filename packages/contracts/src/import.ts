import type { SiteInput, Principal, Job } from './model.js';
export type ImportRow = SiteInput & {
    rowNumber: number;
    logo?: string;
};
export interface RowIssue {
    rowNumber: number;
    column: string;
    code: string;
    message: string;
}
export interface ImportResult {
    rows: ImportRow[];
    issues: RowIssue[];
}
export interface ImportRowView {
    rowNumber: number;
    input: ImportRow;
    issues: RowIssue[];
    siteId: string | null;
    job: Pick<Job, 'id' | 'stage' | 'state'> | null;
}
export interface ImportSummary {
    id: string;
    revision: number;
    name: string;
    state: 'uploading' | 'preview' | 'active' | 'paused' | 'cancelled';
    validCount: number;
    invalidCount: number;
    total: number;
    canControl: boolean;
    /** Current batch-wide autonomous admission/generation activity, independent of the row page. */
    activeWork?: boolean;
    assignedUserIds?: string[];
}
export interface ImportPage {
    items: ImportRowView[];
    nextCursor: string | null;
}
export function rowFingerprint(row: ImportRowView) { const r = row.input; return JSON.stringify([row.rowNumber, r.domain, r.about ?? '', r.referenceId ?? '', r.layoutReferenceId ?? '', r.logo ?? '', r.logoAssetId ?? '', r.mentionedUrl ?? '', r.mentionedDescription ?? '', row.issues.map(i => [i.rowNumber, i.column, i.code, i.message]), row.siteId]); }
export interface BatchService {
    submitBatch(actor: Principal, validRows: ImportRow[], requestKey: string): Promise<{
        batchId: string;
        siteIds: string[];
    }>;
    pauseBatch(actor: Principal, id: string): Promise<void>;
    resumeBatch(actor: Principal, id: string): Promise<void>;
    cancelBatch(actor: Principal, id: string): Promise<void>;
}
export const importLimits = { sourceBytes: 16 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024, entries: 256, rows: 5000, columns: 16, cellCharacters: 8000, chunkBytes: 24000, pageRows: 5 } as const;
export const importMethods: Record<string, string[]> = {
    'resource.begin': ['name', 'size', 'sha256', 'draftId', 'rowNumber', 'revision'],
    'resource.chunk': ['id', 'index', 'base64'], 'import.prepare': ['id'],
    'import.update': ['id', 'revision', 'rowNumber', 'domain', 'about', 'referenceId', 'layoutReferenceId', 'mentionedUrl', 'mentionedDescription'],
    'import.commit': ['id', 'revision', 'requestKey'], 'logo.complete': ['id'],
    'batch.retry': ['id', 'rowNumber', 'modelIdentity'], 'batch.assign': ['id', 'userIds'], 'batch.list': ['cursor'], 'batch.get': ['id'], 'batch.rows': ['id', 'cursor', 'status'],
    'batch.delete':['id','revision'], 'batch.pause': ['id'], 'batch.resume': ['id'], 'batch.cancel': ['id'],
};
