import type { PublicationState } from './model.js';
export type { PublicationState } from './model.js';
export interface PublicationIntent {
    id: string;
    siteId: string;
    revisionId: string;
    manifestHash: string;
    deploymentId: string | null;
    phase: PublicationState;
}
export interface DnsRecord {
    type: 'A' | 'CNAME' | 'TXT';
    name: string;
    value: string;
}
export interface DomainSetup {
    records: DnsRecord[];
    verified: boolean;
}
export interface PublicationView extends PublicationIntent {
    revisionId: string;
    manifestId: string;
    retryAt: number | null;
    cancelRequested: boolean;
    settlement: 'pending' | 'settled' | 'cancelled' | 'conflict';
    verifiedAt: number | null;
    origin: 'generation' | 'draft' | 'rollback';
}
export interface PublicationReceipt {
    jobId: string;
    requestKey: string;
    siteId: string;
    revisionId: string;
    manifestId: string;
    expectedRevision: number;
    checkpointId: string;
}
