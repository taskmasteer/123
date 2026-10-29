import type { Checkpoint, Principal, Revision, ValidationReport } from './model.js';
export type PayloadKind = 'artifact' | 'checkpoint' | 'screenshot' | 'resource' | 'catalog';
export interface PayloadRef {
    kind: PayloadKind;
    id: string;
}
export interface PhysicalObject {
    key: string;
    size: number;
    sha256: string;
    mediaType: string;
}
export interface PayloadInventory extends PayloadRef {
    accepted?: boolean;
    producer?: {
        jobId: string;
        workerId: string;
        generation: number;
    };
    siteId: string | null;
    objects: PhysicalObject[];
    createdAt: number;
    protectUntil: number;
    state: 'staging' | 'available' | 'claimed' | 'deleted';
    firstOrphanAt: number | null;
    claimToken: string | null;
}
export interface CheckpointEvidence {
    version: 1;
    checkpoint: Checkpoint;
    state: Record<string, unknown>;
    sourceDigest: string;
    filesDigest: string;
    digest: string;
}
export interface JobUsage {
    imagePending?:boolean;
    version: 1;
    jobId: string;
    checkpointId: string;
    predecessor: string | null;
    inputTokens: number;
    outputTokens: number;
    uncertainRequests: number;
    requestPending: boolean;
    provenance: 'provider' | 'demo' | 'visual' | 'unknown';
    coverage: 'known-subtotal' | 'unknown';
    durationMs: number | null;
    imageTokens: number | null;
}
export interface CheckpointProjection {
    evidence: CheckpointEvidence;
    usage: JobUsage;
    execution: PayloadRef[];
    retained: PayloadRef[];
}
export interface PublicationOutcome {
    sequence?: number;
    id: string;
    siteId: string;
    revisionId: string;
    manifestId: string;
    settledAt: number;
    verifiedAt: number | null;
    settlement: 'settled' | 'pending' | 'conflict' | 'cancelled';
    origin: 'generation' | 'draft' | 'rollback';
    mode: 'demo' | 'managed';
}
export interface HistoryEntry extends PublicationOutcome {
    orderingUncertain?: boolean;
    available: boolean;
    current: boolean;
    retained: boolean;
}
export interface ExportHandle {
    id: string;
    kind: 'source' | 'file' | 'backup';
    size: number;
    sha256: string;
    expiresAt: number;
}
export interface RestoreReport {
    restoredSites: number;
    restoredRevisions: number;
    targetId: string;
    quarantined: boolean;
    sourceUsers: string[];
    stagedRemnants: string[];
}
export interface SourceAccess {
    admin(actor: Principal): Promise<void>;
    revision(siteId: string, revisionId: string): Promise<Revision | null>;
    read(manifestId: string): Promise<import('./model.js').ArtifactFile[]>;
}
export type EvidenceReport = ValidationReport;
