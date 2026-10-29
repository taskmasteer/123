import { it, expect } from 'vitest';
import { validateLogicalRecoveryRecord, monitoringRecoveryRow, type RecoveryRecord } from '../src/recovery-records.js';
import { storedObservationUuid, healthObservation } from '../../contracts/src/monitoring.js';
import { uuid } from '../../contracts/src/http.js';
it('accepts full stored UUID values without broadening action UUIDs or cross-site observation bindings', () => {
    const id = 'aaaaaaaa-bbbb-ffff-0000-cccccccccccc', other = 'bbbbbbbb-cccc-0000-ffff-dddddddddddd';
    expect(storedObservationUuid(id.toUpperCase())).toBe(id);
    expect(() => uuid(id)).toThrow();
    expect(() => storedObservationUuid('aaaa-bbbb')).toThrow();
    const data = healthObservation({ siteId: id, revisionId: other, outcomeId: id, checkedAt: 1, status: 'ok', code: 'ok', provenance: 'managed' });
    expect(data.revisionId).toBe(other);
    expect(() => validateLogicalRecoveryRecord({ type: 'row', table: 'public.health', row: { site_id: other, data } }, 9)).toThrow();
});
it('rejects activity metadata smuggled under a schema8 header', () => { expect(() => validateLogicalRecoveryRecord({ type: 'row', table: 'private.job_activity', row: { job_id: 'job', data: { jobId: 'job', durationMs: 12, coverage: 'partial', generation: null, sequence: null, fingerprint: null } } } as RecoveryRecord)).toThrow(); });
it('strips operational replay/claim authority and retains historical partial measurements', () => { const activity = monitoringRecoveryRow('private.job_activity', { job_id: 'job', data: { jobId: 'job', durationMs: 12, coverage: 'partial', generation: 1, sequence: 3, fingerprint: 'private' } }, true); expect(activity.data).toMatchObject({ durationMs: 12, generation: null, sequence: null, fingerprint: null }); expect(() => validateLogicalRecoveryRecord({ type: 'row', table: 'private.job_activity', row: activity }, 9)).not.toThrow(); const health = monitoringRecoveryRow('private.health_observations', { token: 'live', worker_id: 'old', expires_at: 5, generation: 2 }, true); expect(health).toMatchObject({ token: null, worker_id: null, expires_at: null, generation: 0 }); });
