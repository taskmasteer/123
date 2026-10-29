import type { ActivitySegment, JobActivity } from '../../contracts/src/monitoring.js';
import { activitySegment } from '../../contracts/src/monitoring.js';
import { AppError } from '../../contracts/src/model.js';
export function nextActivity(previous: JobActivity | null, jobId: string, generation: number, input: ActivitySegment): JobActivity {
    const segment = activitySegment(input), fingerprint = JSON.stringify(segment);
    if (previous?.jobId !== undefined && previous.jobId !== jobId || previous?.generation !== null && previous?.generation !== undefined && previous.generation > generation)
        throw new AppError('STALE_LEASE', 'Устаревшее измерение.');
    const same = previous?.generation === generation;
    if (same && segment.sequence === previous.sequence) {
        if (previous.fingerprint !== fingerprint)
            throw new AppError('CONFLICT', 'Измерение уже принято с другим значением.');
        return previous;
    }
    if (segment.sequence !== (same ? (previous.sequence ?? 0) + 1 : 1))
        throw new AppError('CONFLICT', 'Пропущено измерение.');
    const durationMs = (previous?.durationMs ?? 0) + segment.durationMs;
    if (!Number.isSafeInteger(durationMs))
        throw new AppError('INVALID_INPUT', 'Переполнение времени.');
    return { jobId, durationMs, coverage: 'partial', generation, sequence: segment.sequence, fingerprint };
}
