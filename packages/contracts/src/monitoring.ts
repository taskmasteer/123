import { AppError } from './model.js';
import { object, integer, uuid, string } from './http.js';
export const healthIntervalMs = 6 * 60 * 60 * 1000;
export const healthCodes = ['ok', 'dns_pending', 'tls_error', 'transport_error', 'wrong_version', 'unsafe_destination', 'policy_unavailable', 'unverified'] as const;
export type HealthCode = typeof healthCodes[number];
export type HealthStatus = 'ok' | 'dns_pending' | 'https_error' | 'unreachable' | 'wrong_version';
export interface HealthObservation {
    siteId: string;
    revisionId: string | null;
    outcomeId: string | null;
    checkedAt: number | null;
    status: HealthStatus | null;
    code: HealthCode;
    provenance: 'managed' | 'demo' | 'restored';
}
export interface HealthClaim {
    siteId: string;
    revisionId: string;
    outcomeId: string;
    token: string;
    generation: number;
    expiresAt: number;
    hostname: string;
    manifestId: string;
    manifestHash: string;
    policyVersion: string;
    policyHash: string;
    file: {
        sha256: string;
        size: number;
        mediaType: string;
    };
}
export interface HealthPort {
    claim(signal?: AbortSignal): Promise<{
        claim: HealthClaim | null;
        nextWakeAt: number;
        serverNow?:number;
    }>;
    complete(claim: HealthClaim, code: HealthCode, signal?: AbortSignal): Promise<{
        accepted: boolean;
    }>;
}
export function healthClaim(value: unknown): HealthClaim { const p = object(value, ['siteId', 'revisionId', 'outcomeId', 'token', 'generation', 'expiresAt', 'hostname', 'manifestId', 'manifestHash', 'policyVersion', 'policyHash', 'file']), f = object(p.file, ['sha256', 'size', 'mediaType']); for (const key of ['manifestHash', 'policyHash'])
    if (!/^[a-f0-9]{64}$/.test(String(p[key])))
        throw new AppError('INVALID_INPUT', 'Некорректный хэш наблюдения.'); if (!/^[a-f0-9]{64}$/.test(String(f.sha256)))
    throw new AppError('INVALID_INPUT', 'Некорректный хэш файла.'); return { siteId: uuid(p.siteId), revisionId: uuid(p.revisionId), outcomeId: uuid(p.outcomeId), token: uuid(p.token), generation: integer(p.generation, 1), expiresAt: integer(p.expiresAt), hostname: string(p.hostname, 253), manifestId: uuid(p.manifestId), manifestHash: String(p.manifestHash), policyVersion: string(p.policyVersion, 100), policyHash: String(p.policyHash), file: { sha256: String(f.sha256), size: integer(f.size, 0, 4000000), mediaType: string(f.mediaType, 100) } }; }
export interface ActivitySegment {
    sequence: number;
    durationMs: number;
}
export interface JobActivity {
    jobId: string;
    durationMs: number;
    coverage: 'partial';
    generation: number | null;
    sequence: number | null;
    fingerprint: string | null;
}
export interface UsageSummary {
    jobs: number;
    measuredJobs: number;
    missingJobs: number;
    inputTokens: number;
    outputTokens: number;
    uncertainRequests: number;
    requestPending: boolean;
    tokenCoverage: 'known-subtotal' | 'unknown';
    provenance: string[];
    imageTokens: null;
    imagePending: boolean | null;
    durationMs: number | null;
    durationCoverage: 'partial' | 'unknown';
    bytesStored: number | null;
    knownBytesStored: number;
    storageCoverage: 'verified-inventory' | 'partial';
    estimatedCostUsd: null;
}
export function activitySegment(value: unknown): ActivitySegment { const p = object(value, ['sequence', 'durationMs']); return { sequence: integer(p.sequence, 1, Number.MAX_SAFE_INTEGER), durationMs: integer(p.durationMs, 0, 45000) }; }
export function healthCode(value: unknown): HealthCode { if (!healthCodes.includes(value as HealthCode))
    throw new AppError('INVALID_INPUT', 'Некорректный результат наблюдения.'); return value as HealthCode; }
export const codeStatus = (code: HealthCode): HealthStatus => code === 'ok' ? 'ok' : code === 'dns_pending' ? 'dns_pending' : code === 'tls_error' ? 'https_error' : code === 'wrong_version' ? 'wrong_version' : 'unreachable';
export const healthCaption = (code: HealthCode) => ({ ok: 'Ожидаемая версия доступна по HTTPS', dns_pending: 'DNS ещё не отвечает', tls_error: 'Не удалось подтвердить сертификат HTTPS', transport_error: 'Сайт недоступен', wrong_version: 'Ответ не совпадает с опубликованной версией', unsafe_destination: 'Небезопасное направление запроса заблокировано', policy_unavailable: 'Политика публикации не поддерживается: проверка ограничена', unverified: 'Публичная доступность ещё не проверена' })[code];
/** Read-only PostgreSQL identity syntax. Action/claim/authentication UUID parsers stay strict. */
export function storedObservationUuid(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    throw new AppError('INVALID_INPUT', 'Некорректный сохранённый идентификатор.'); return value.toLowerCase(); }
export function healthObservation(value: unknown): HealthObservation { const p = object(value, ['siteId', 'revisionId', 'outcomeId', 'checkedAt', 'status', 'code', 'provenance']); const code = healthCode(p.code); if (p.status !== null && p.status !== codeStatus(code) || !['managed', 'demo', 'restored'].includes(String(p.provenance)))
    throw new AppError('INVALID_INPUT', 'Некорректное наблюдение.'); return { siteId: storedObservationUuid(p.siteId), revisionId: p.revisionId === null ? null : storedObservationUuid(p.revisionId), outcomeId: p.outcomeId === null ? null : storedObservationUuid(p.outcomeId), checkedAt: p.checkedAt === null ? null : integer(p.checkedAt), status: p.status as HealthStatus | null, code, provenance: p.provenance as HealthObservation['provenance'] }; }
export function usageSummary(value: unknown): UsageSummary { const p = object(value, ['jobs', 'measuredJobs', 'missingJobs', 'inputTokens', 'outputTokens', 'uncertainRequests', 'requestPending', 'tokenCoverage', 'provenance', 'imageTokens', 'imagePending', 'durationMs', 'durationCoverage', 'bytesStored', 'knownBytesStored', 'storageCoverage', 'estimatedCostUsd']); for (const k of ['jobs', 'measuredJobs', 'missingJobs', 'inputTokens', 'outputTokens', 'uncertainRequests', 'knownBytesStored'])
    integer(p[k]); for (const k of ['durationMs', 'bytesStored'])
    if (p[k] !== null)
        integer(p[k]); if (p.imagePending !== null && typeof p.imagePending !== 'boolean')
    throw new AppError('INVALID_INPUT', 'Некорректное состояние изображения.'); if (p.estimatedCostUsd !== null || p.imageTokens !== null || typeof p.requestPending !== 'boolean' || !['known-subtotal', 'unknown'].includes(String(p.tokenCoverage)) || !['partial', 'unknown'].includes(String(p.durationCoverage)) || !['verified-inventory', 'partial'].includes(String(p.storageCoverage)) || !Array.isArray(p.provenance) || p.provenance.some(x => !['provider', 'demo', 'visual', 'unknown'].includes(String(x))))
    throw new AppError('INVALID_INPUT', 'Некорректная сводка использования.'); return p as unknown as UsageSummary; }
