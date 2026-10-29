import type { LocalDatabase } from './local-database.js';
import { healthObservation } from '../../contracts/src/monitoring.js';
import type { HealthObservation } from '../../contracts/src/monitoring.js';
export function localHealth(db: LocalDatabase, siteId: string): HealthObservation { return healthObservation(JSON.parse(String(db.sql.prepare('select data from health where site_id=?').get(siteId)?.data ?? 'null')) ?? { siteId, revisionId: null, outcomeId: null, checkedAt: null, status: null, code: 'unverified', provenance: 'demo' }); }
export function localUsage(db: LocalDatabase, siteId?: string) {
    return db.transaction(() => {
        const r = db.sql.prepare(`select count(*) jobs,count(u.job_id) projected,count(a.job_id) measured,coalesce(sum(json_extract(u.data,'$.inputTokens')),0) inputs,coalesce(sum(json_extract(u.data,'$.outputTokens')),0) outputs,coalesce(sum(json_extract(u.data,'$.uncertainRequests')),0) uncertain,coalesce(max(json_extract(u.data,'$.requestPending')),0) pending,coalesce(max(json_extract(u.data,'$.imagePending')),0) image_pending,coalesce(max(json_extract(u.data,'$.coverage')='known-subtotal'),0) known,coalesce(sum(json_extract(a.data,'$.durationMs')),0) duration from jobs j left join job_usage u on u.job_id=j.id left join job_activity a on a.job_id=j.id where (? is null or j.site_id=?)`).get(siteId ?? null, siteId ?? null)!;
        const storage = db.sql.prepare(`with physical as(select case p.kind when 'artifact' then 'artifacts/' when 'checkpoint' then 'checkpoints/' when 'screenshot' then 'validation/' when 'catalog' then 'catalog/' else '' end||json_extract(f.value,'$.key') identity,min(json_extract(f.value,'$.size')) size,count(distinct json_array(json_extract(f.value,'$.size'),json_extract(f.value,'$.sha256'),json_extract(f.value,'$.mediaType'))) versions from payload_inventory p,json_each(p.data,'$.objects') f where p.state='available' and (? is null or p.site_id=?) group by 1) select coalesce(sum(size),0) bytes,coalesce(max(versions<>1),0) conflict from physical`).get(siteId ?? null, siteId ?? null)!;
        if (storage.conflict)
            throw new Error('Противоречивая физическая опись.');
        const n = (v: unknown) => { const x = Number(v); if (!Number.isSafeInteger(x) || x < 0)
            throw new Error('Переполнение сводки.'); return x; };
        const provenance = db.sql.prepare(`select distinct json_extract(u.data,'$.provenance') value from job_usage u join jobs j on j.id=u.job_id where (? is null or j.site_id=?) limit 4`).all(siteId ?? null, siteId ?? null).map(r => String(r.value));
        return { jobs: n(r.jobs), measuredJobs: n(r.measured), missingJobs: n(r.jobs) - n(r.projected), inputTokens: n(r.inputs), outputTokens: n(r.outputs), uncertainRequests: n(r.uncertain), requestPending: !!r.pending, tokenCoverage: r.known ? 'known-subtotal' : 'unknown', provenance, imageTokens: null, imagePending: r.image_pending ? true : null, durationMs: n(r.measured) ? n(r.duration) : null, durationCoverage: n(r.measured) ? 'partial' : 'unknown', bytesStored: null, knownBytesStored: n(storage.bytes), storageCoverage: 'partial', estimatedCostUsd: null };
    });
}
