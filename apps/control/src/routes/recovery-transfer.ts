import { createHash } from 'node:crypto';
import type { Principal } from '../../../../packages/contracts/src/model.js';
import { object, uuid } from '../../../../packages/contracts/src/http.js';
import { PostgresRecoveryTransfer } from '../../../../packages/adapters/src/postgres-recovery-transfer.js';
import type { PostgresBackup } from '../../../../packages/adapters/src/postgres-backup.js';
/** Only after AuthPort verified this exact bearer. Body claims never participate. */
export function verifiedRecoverySession(token: string, actor: Principal) {
    let session: string | undefined;
    try {
        const p = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
        if (p.sub === actor.userId && typeof p.iss === 'string' && typeof p.session_id === 'string') {
            uuid(p.session_id);
            session = JSON.stringify([p.iss, p.sub, p.session_id]);
        }
    }
    catch { }
    return createHash('sha256').update(session ?? token).digest('hex');
}
export function recoveryTransferSelection(request: Request, url: URL) {
    const m = /^\/admin\/recovery\/(snapshots|restores)\/([a-f0-9-]{36})\/(batch|prepare|commit|renew|cancel)$/.exec(url.pathname);
    if (!m)
        return undefined;
    const action = m[3]!, kind = m[1]!;
    if (action === 'batch' ? (kind === 'snapshots' ? request.method !== 'GET' : request.method !== 'POST') : request.method !== 'POST' || (action === 'prepare' || action === 'commit') && kind !== 'restores')
        return undefined;
    return {
        id: uuid(m[2]), kind, action, large: kind === 'restores' && action === 'batch'
    };
}
export async function recoveryTransferRoute(backup: PostgresBackup, actor: Principal, scope: string, request: Request, url: URL, body: unknown) {
    const selected = recoveryTransferSelection(request, url);
    if (!selected)
        return undefined;
    const t = new PostgresRecoveryTransfer(backup, scope), { id, action } = selected;
    if (action === 'batch')
        return request.method === 'GET' ? t.readBatch(actor, id, url.searchParams.get('cursor') ?? 'start') : t.stageBatch(actor, id, body);
    object(body, []);
    if (action === 'prepare')
        return t.prepareBatch(actor, id);
    if (action === 'commit')
        return t.commitPrepared(actor, id);
    if (action === 'renew')
        return t.renew(actor, id);
    return t.cancel(actor, id);
}
