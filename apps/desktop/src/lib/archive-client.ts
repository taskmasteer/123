import { desktopClient } from './desktop-client.js';
export interface ArchiveResult {
    handle?: {
        id: string;
        kind: string;
        size: number;
        sha256: string;
        expiresAt: number;
    };
    inspectionId?: string;
    adapter?: 'local' | 'managed';
    users?: {
        id: string;
        email: string | null;
    }[];
    restoredSites?: number;
    restoredRevisions?: number;
    restartRequired?: boolean;
    quarantined?: boolean;
}
export async function archiveCall<T>(request: unknown): Promise<T> { if (!desktopClient.archive)
    throw new Error('Копии доступны в настольном приложении.'); return desktopClient.archive<T>(request); }
export async function awaitArchive(id: string, signal: AbortSignal, onState?: (message: string) => void): Promise<ArchiveResult> { while (!signal.aborted) {
    const status = await archiveCall<{
        state: string;
        result?: ArchiveResult;
        error?: string;
    }>({ action: 'status', id });
    if (status.state === 'ready')
        return status.result ?? {};
    if (status.state === 'failed')
        throw new Error(status.error ?? 'Не удалось завершить операцию.');
    onState?.('Идёт проверка и подготовка файлов…');
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }, timer = setTimeout(done, 350); signal.addEventListener('abort', done, { once: true }); });
} throw new Error('Операция больше не открыта в этом окне.'); }
