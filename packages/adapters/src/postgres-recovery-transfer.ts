import { createHash, randomUUID } from 'node:crypto';
import { AppError, type Principal } from '../../contracts/src/model.js';
import { batchContent, transferBatch, transferBinding, transferCursor, transferLimits, type RecoveryTransferBinding, type RecoveryTransferPage, type RecoveryPreparationProgress } from '../../contracts/src/recovery-transfer.js';
import type { PostgresBackup } from './postgres-backup.js';
import type { SqlTransaction } from './supabase-repository.js';
import { managedRecoveryTables, recoveryPath, validateLogicalRecoveryRecord, type RecoveryRecord } from './recovery-records.js';
import { PostgresRestorePreparation, type PreparationState } from './postgres-restore-preparation.js';
import { verifyValidationPng } from './import-resources.js';
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
/** One immutable PNG-shape proof per requested digest, never all matching physical objects. */
export const verifiedPngProofQuery = "select h.hash from (select distinct unnest($2::text[]) hash) h cross join lateral(select 1 from private.recovery_snapshot_records v where v.snapshot_id=$1 and v.seq>=4000000000 and v.seq<5000000000 and v.data->>'type'='verified' and v.data->'pngVerified'='true'::jsonb and v.data->>'sha256'=h.hash limit 1) proof";
const bad = (message = 'Порядок или содержимое пакетов восстановления повреждены.'): never => { throw new AppError('INVALID_INPUT', message); };
type State = {
    id: string;
    binding: RecoveryTransferBinding;
    phase: RecoveryPreparationProgress['phase'];
    metadata_seq: string;
    resource_seq: string;
    resource_offset: number;
    data: any;
    claim: string | null;
    claim_expires: Date | null;
};
/** Durable transport state is operational, never included in a portable archive. */
export class PostgresRecoveryTransfer {
    constructor(readonly backup: PostgresBackup, readonly scope?: string) { }
    get repo() { return this.backup.repository; }
    async bindIssued(tx: SqlTransaction, id: string, sourceId: string, records: number, resourceSeq: number, inventory?: unknown) {
        const binding: RecoveryTransferBinding = {
            version: 1, id, sourceId, records, digest: sha(JSON.stringify({
                id, sourceId, records, inventory: inventory ?? null
            }))
        };
        await tx.query("insert into private.recovery_transfers(id,session_scope,binding,resource_seq,created_at,max_expires_at) select $1,$2,$3,$4,expires_at-interval '1 hour',expires_at+interval '23 hours' from private.recovery_snapshots where id=$1", [id, this.scope ?? null, binding, resourceSeq]);
    }
    private async state(actor: Principal, id: string, tx: SqlTransaction, mappings?: 'freeze' | 'verify'): Promise<State> {
        const snapshot = await this.backup.snapshot(actor, id, tx);
        let state = (await tx.query('select *,max_expires_at>clock_timestamp() live from private.recovery_transfers where id=$1 for update', [id])).rows[0];
        if (!state) {
            const stats = (await tx.query('select count(*) n from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000', [id])).rows[0];
            const header = snapshot.data.header ?? (await tx.query('select data from private.recovery_snapshot_records where snapshot_id=$1 and seq=0', [id])).rows[0]?.data;
            const records = snapshot.data.kind === 'restore' ? snapshot.data.records : Number(stats.n);
            const binding: RecoveryTransferBinding = {
                version: 1, id, sourceId: header?.sourceId ?? id, records, digest: sha(JSON.stringify({
                    id, sourceId: header?.sourceId ?? id, records, inventory: snapshot.data.inventoryDigest ?? null
                }))
            };
            const first = (await tx.query("select min(seq) seq from private.recovery_snapshot_records r where snapshot_id=$1 and seq<1000000 and data->>'type'='file' and not exists(select 1 from private.recovery_snapshot_records v where v.snapshot_id=r.snapshot_id and v.seq=4000000000+r.seq)", [id])).rows[0];
            state = (await tx.query("insert into private.recovery_transfers(id,session_scope,binding,metadata_seq,resource_seq,created_at,max_expires_at) select $1,$2,$3,$4,$5,expires_at-interval '1 hour',expires_at+interval '23 hours' from private.recovery_snapshots where id=$1 returning *", [id, this.scope ?? null, binding, snapshot.data.kind === 'restore' ? Number(stats.n) : 0, first.seq ?? records])).rows[0];
        }
        if (state.live === false)
            throw new AppError('NOT_FOUND', 'Сеанс копии истёк.');
        if (this.scope && state.session_scope && state.session_scope !== this.scope)
            throw new AppError('NOT_FOUND', 'Сеанс относится к другому входу.');
        if (this.scope && !state.session_scope)
            await tx.query('update private.recovery_transfers set session_scope=$2 where id=$1', [id, this.scope]);
        if (state.phase === 'cancelled' || state.phase === 'failed')
            throw new AppError('CONFLICT', 'Сеанс восстановления закрыт.');
        if (mappings) {
            const digest = sha(JSON.stringify(snapshot.data.verified)), frozen = state.data.mappingDigest;
            if (frozen === undefined && mappings === 'freeze' && state.phase === 'staging') {
                await tx.query("update private.recovery_transfers set data=data||jsonb_build_object('mappingDigest',$2::text) where id=$1", [id, digest]);
                state.data = {
                    ...state.data, mappingDigest: digest
                };
            }
            else if (frozen !== digest)
                throw new AppError('CONFLICT', 'Привязки Auth не совпадают с закреплённой подготовкой.');
        }
        return state;
    }
    async authorize(actor: Principal, id: string, kind?: string, closing = false) {
        await this.repo.transaction(async (tx) => {
            await this.backup.admin(actor, tx);
            const row = (await tx.query('select s.actor_id,s.data,t.session_scope from private.recovery_snapshots s left join private.recovery_transfers t on t.id=s.id where s.id=$1', [id])).rows[0];
            if (!row) {
                if (closing)
                    return;
                throw new AppError('NOT_FOUND', 'Сеанс копии не найден.');
            }
            if (row.actor_id !== actor.userId || this.scope && row.session_scope !== this.scope || kind && (kind === 'restores') !== (row.data.kind === 'restore'))
                throw new AppError('NOT_FOUND', 'Другой сеанс копии.');
            if (!closing)
                await this.state(actor, id, tx);
        });
    }
    private progress(s: State): RecoveryPreparationProgress {
        return {
            binding: s.binding, phase: s.phase, prepared: Number(s.data.preparation?.after ?? -1) + 1, total: s.binding.records, cursor: transferCursor(s.binding, Number(s.metadata_seq) < s.binding.records ? 'metadata' : 'resources', Number(s.metadata_seq) < s.binding.records ? Number(s.metadata_seq) : Number(s.resource_seq), Number(s.metadata_seq) < s.binding.records ? Number(s.data.metadataOffset ?? 0) : s.resource_offset)
        };
    }
    private cursor(binding: RecoveryTransferBinding, value: string) {
        if (value === 'start')
            return {
                kind: 'metadata' as const, seq: 0, offset: 0, end: binding.records
            };
        const p = /^1:([a-f0-9]{64}):(m|r):(\d{1,7}):(\d{1,9}):(\d{1,7})$/.exec(value);
        if (!p || p[1] !== binding.digest)
            return bad();
        const seq = Number(p[3]), offset = Number(p[4]), end = Number(p[5]);
        if (seq > end || end > binding.records || offset > transferLimits.member)
            return bad();
        return {
            kind: p[2] === 'm' ? 'metadata' as const : 'resources' as const, seq, offset, end
        };
    }
    private async renewTx(actor: Principal, id: string, tx: SqlTransaction) {
        const s = await this.state(actor, id, tx);
        const current = (await tx.query("select expires_at,expires_at>clock_timestamp()+interval '30 minutes' ample from private.recovery_snapshots where id=$1", [id])).rows[0];
        // Checking a page is cheap; renewing120k pins on every page is not.
        if (current.ample)
            return {
                state: s, expiresAt: new Date(current.expires_at).getTime()
            };
        const result = await tx.query("update private.recovery_snapshots s set expires_at=least(clock_timestamp()+interval '60 minutes',t.max_expires_at) from private.recovery_transfers t where s.id=$1 and t.id=s.id and s.expires_at>clock_timestamp() and t.max_expires_at>clock_timestamp() returning s.expires_at", [id]);
        if (!result.rowCount)
            throw new AppError('NOT_FOUND', 'Сеанс копии истёк.');
        await tx.query('update private.payload_pins p set expires_at=$2 where id=$1 and expires_at>clock_timestamp()', [id, result.rows[0].expires_at]);
        return {
            state: s, expiresAt: new Date(result.rows[0].expires_at).getTime()
        };
    }
    async renew(actor: Principal, id: string) {
        return this.repo.transaction(async (tx) => {
            const r = await this.renewTx(actor, id, tx);
            return {
                ...this.progress(r.state), expiresAt: r.expiresAt
            };
        });
    }
    async readBatch(actor: Principal, id: string, cursor: string): Promise<RecoveryTransferPage> {
        const initial = await this.repo.transaction(async (tx) => {
            const r = await this.renewTx(actor, id, tx);
            const snapshot = await this.backup.snapshot(actor, id, tx);
            if (snapshot.data.kind === 'restore')
                return bad();
            return r;
        });
        const started = performance.now(), binding = initial.state.binding, c = this.cursor(binding, cursor), items: RecoveryTransferPage['items'] = [];
        let seq = c.seq, offset = c.offset, raw = 0, resourceCursor: string | null = null;
        if (c.kind === 'metadata') {
            const rows = (await this.repo.pool.query('with sizes as(select seq,octet_length(data::text) n from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 and seq<$2::bigint+256 order by seq limit 256),bounded as(select seq,sum(n) over(order by seq) bytes from sizes) select r.seq,r.data::text text from bounded b join private.recovery_snapshot_records r on r.snapshot_id=$1 and r.seq=b.seq where b.bytes<=1048576 order by r.seq', [id, seq, c.end])).rows;
            for (const row of rows) {
                const n = Number(row.seq), bytes = Buffer.from(row.text), length = Math.min(bytes.length - offset, transferLimits.raw - raw);
                if (n !== seq || bytes.length > transferLimits.record)
                    return bad('Позиция метаданных отсутствует или превышает лимит.');
                if (length < 1)
                    break;
                const complete = offset + length === bytes.length;
                items.push({
                    seq, offset, size: bytes.length, sha256: sha(bytes), base64: bytes.subarray(offset, offset + length).toString('base64'), complete
                });
                raw += length;
                if (complete) {
                    seq++;
                    offset = 0;
                }
                else {
                    offset += length;
                    break;
                }
            }
            if (items.length)
                resourceCursor = transferCursor(binding, 'resources', c.seq, 0, seq);
        }
        else {
            const rows = (await this.repo.pool.query("select seq,data from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 and data->>'type'='file' order by seq limit 64", [id, seq, c.end])).rows;
            for (const row of rows) {
                if (items.length && performance.now() - started > 10000)
                    break;
                const record = row.data as Extract<RecoveryRecord, {
                    type: 'file';
                }>;
                seq = Number(row.seq);
                const length = Math.min(record.size - offset, transferLimits.raw - raw);
                if (length < 1 && record.size !== 0)
                    break;
                let bytes: Uint8Array;
                if (this.backup.store.transport.range && length)
                    bytes = await this.backup.store.transport.range(record.path, offset, length, AbortSignal.timeout(20000));
                else {
                    const full = await this.backup.store.transport.get(record.path, record.size, AbortSignal.timeout(20000));
                    if (full.length !== record.size || sha(full) !== record.sha256)
                        return bad('Объект копии повреждён.');
                    bytes = full.subarray(offset, offset + length);
                }
                if (bytes.length !== length)
                    return bad('Диапазон объекта усечён.');
                const complete = offset + length === record.size;
                items.push({
                    seq, offset, size: record.size, sha256: record.sha256, base64: Buffer.from(bytes).toString('base64'), complete
                });
                raw += length;
                if (complete) {
                    seq++;
                    offset = 0;
                }
                else {
                    offset += length;
                    break;
                }
                if (raw === transferLimits.raw)
                    break;
            }
            const next = (await this.repo.pool.query("select min(seq) seq from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 and data->>'type'='file'", [id, seq, c.end])).rows[0].seq;
            if (next === null) {
                seq = c.end;
                offset = 0;
            }
            else
                seq = Number(next);
        }
        if (!items.length) {
            // An empty resource window has no network work; metadata pages explicitly declare it below.
            return bad('В пакете нет записей.');
        }
        if (c.kind === 'metadata' && resourceCursor) {
            const files = (await this.repo.pool.query("select min(seq) seq from private.recovery_snapshot_records where snapshot_id=$1 and seq>=$2 and seq<$3 and data->>'type'='file'", [id, c.seq, seq])).rows[0].seq;
            resourceCursor = files === null ? null : transferCursor(binding, 'resources', Number(files), 0, seq);
        }
        await this.repo.transaction(tx => this.renewTx(actor, id, tx));
        const batch = {
            binding, kind: c.kind, cursor, items
        }, page = {
            ...batch, digest: sha(batchContent(batch)), nextCursor: seq >= c.end ? null : transferCursor(binding, c.kind, seq, offset, c.end), resourceCursor, expiresAt: initial.expiresAt
        };
        transferBatch(page, true);
        return page;
    }
    private validateRecord(record: RecoveryRecord) {
        if (!record || !['header', 'row', 'file'].includes(record.type))
            return bad();
        validateLogicalRecoveryRecord(record);
        if (record.type === 'row' && !(managedRecoveryTables as readonly string[]).includes(record.table))
            return bad('Неизвестная таблица копии.');
        if (record.type === 'file') {
            recoveryPath(record.path);
            if (!['object', 'catalog'].includes(record.root) || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > transferLimits.member || !/^[a-f0-9]{64}$/.test(record.sha256) || typeof record.mediaType !== 'string' || record.mediaType.length > 100)
                return bad();
            if (record.root === 'object')
                this.backup.remap(record.path, '00000000-0000-4000-8000-000000000000');
        }
    }
    async stageBatch(actor: Principal, id: string, input: unknown): Promise<RecoveryPreparationProgress> {
        const batch = transferBatch(input);
        if (sha(batchContent(batch)) !== batch.digest)
            return bad('Хэш пакета не совпадает.');
        let state = await this.repo.transaction(tx => this.state(actor, id, tx));
        if (JSON.stringify(transferBinding(state.binding)) !== JSON.stringify(batch.binding))
            return bad('Источник пакета изменился.');
        const old = (await this.repo.pool.query('select * from private.recovery_transfer_receipts where id=$1 and cursor=$2', [id, batch.cursor])).rows[0];
        if (old && old.digest !== batch.digest)
            throw new AppError('CONFLICT', 'Повтор пакета содержит другие байты.');
        if (!old) {
            if (state.phase !== 'staging' || batch.cursor !== this.progress(state).cursor)
                return bad();
            const records: {
                seq: number;
                data: RecoveryRecord;
                size: number;
                sha256: string;
            }[] = [], parts: {
                seq: number;
                offset: number;
                bytes: string;
            }[] = [];
            const descriptors = batch.kind === 'resources' ? (await this.repo.pool.query("select r.seq,r.data,(select min(n.seq) from private.recovery_snapshot_records n where n.snapshot_id=r.snapshot_id and n.seq>r.seq and n.seq<1000000 and n.data->>'type'='file') next_seq from private.recovery_snapshot_records r where r.snapshot_id=$1 and r.seq=any($2::bigint[]) and r.seq<1000000 and r.data->>'type'='file' order by r.seq", [id, [...new Set(batch.items.map(p => p.seq))]])).rows : [];
            const descriptorBySeq = new Map(descriptors.map(r => [Number(r.seq), r.data]));
            const nextBySeq = new Map(descriptors.map(r => [Number(r.seq), Number(r.next_seq ?? state.binding.records)]));
            let pendingMetadata = state.data.metadataPending ?? null;
            let seq = batch.kind === 'metadata' ? Number(state.metadata_seq) : Number(state.resource_seq), offset = batch.kind === 'metadata' ? Number(state.data.metadataOffset ?? 0) : state.resource_offset, metadataBytes = 0, payloadBytes = 0;
            for (const part of batch.items) {
                if (part.seq !== seq || part.offset !== offset)
                    return bad();
                if (batch.kind === 'metadata' && pendingMetadata && (pendingMetadata.seq !== part.seq || pendingMetadata.size !== part.size || pendingMetadata.sha256 !== part.sha256))
                    return bad('Привязка части метаданных изменилась.');
                const bytes = Buffer.from(part.base64, 'base64');
                if (!part.complete && bytes.length < 24000)
                    return bad('Незавершённая часть слишком мала.');
                parts.push({
                    seq, offset, bytes: '\\x' + bytes.toString('hex')
                });
                if (batch.kind === 'metadata' && part.complete) {
                    const previous = offset ? (await this.repo.pool.query("select offset_bytes,bytes from private.recovery_transfer_parts where id=$1 and kind='metadata' and seq=$2 order by offset_bytes", [id, seq])).rows : [];
                    let at = 0;
                    for (const p of previous) {
                        if (p.offset_bytes !== at)
                            return bad();
                        at += p.bytes.length;
                    }
                    if (at !== offset)
                        return bad();
                    const full = Buffer.concat([...previous.map(p => p.bytes), bytes]);
                    if (full.length !== part.size || sha(full) !== part.sha256)
                        return bad('Хэш метаданных не совпадает.');
                    let record: RecoveryRecord;
                    try {
                        record = JSON.parse(new TextDecoder('utf8', {
                            fatal: true
                        }).decode(full));
                    }
                    catch {
                        return bad();
                    }
                    this.validateRecord(record);
                    if (seq === 0 && (record.type !== 'header' || record.adapter !== 'managed' || record.sourceId !== state.binding.sourceId || record.schema !== 8 || record.version !== 1) || seq !== 0 && record.type === 'header')
                        return bad('Заголовок источника изменился.');
                    records.push({
                        seq, data: record, size: full.length, sha256: part.sha256
                    });
                    metadataBytes += full.length;
                    if (record.type === 'file')
                        payloadBytes += record.size;
                }
                if (batch.kind === 'resources') {
                    const descriptor = descriptorBySeq.get(seq);
                    if (descriptor?.type !== 'file' || descriptor.size !== part.size || descriptor.sha256 !== part.sha256)
                        return bad('Пакет не соответствует описи.');
                }
                if (batch.kind === 'metadata')
                    pendingMetadata = part.complete ? null : {
                        seq: part.seq, size: part.size, sha256: part.sha256
                    };
                if (part.complete) {
                    offset = 0;
                    if (batch.kind === 'metadata')
                        seq++;
                    else
                        seq = nextBySeq.get(seq) ?? state.binding.records;
                }
                else
                    offset += bytes.length;
            }
            await this.repo.transaction(async (tx) => {
                state = await this.state(actor, id, tx);
                const prior = (await tx.query('select digest from private.recovery_transfer_receipts where id=$1 and cursor=$2', [id, batch.cursor])).rows[0];
                if (prior) {
                    if (prior.digest !== batch.digest)
                        throw new AppError('CONFLICT', 'Повтор пакета изменён.');
                    return;
                }
                if (batch.cursor !== this.progress(state).cursor)
                    return bad();
                const snapshot = await this.backup.snapshot(actor, id, tx);
                if (snapshot.data.kind !== 'restore')
                    return bad();
                const mappingDigest = sha(JSON.stringify(snapshot.data.verified));
                if (state.data.mappingDigest && state.data.mappingDigest !== mappingDigest)
                    throw new AppError('CONFLICT', 'Привязки Auth изменились после начала передачи.');
                const staging = Number(snapshot.data.objectStagingBytes ?? 0) + (batch.kind === 'resources' ? parts.reduce((n, p) => n + (p.bytes.length - 2) / 2, 0) : 0), meta = Number(snapshot.data.metadataBytes ?? 0) + metadataBytes, payload = Number(snapshot.data.payloadBytes ?? 0) + payloadBytes;
                if (staging > transferLimits.staging || meta > 768 * 1024 ** 2 || meta + payload > 48 * 1024 ** 3)
                    return bad('Превышен лимит временных данных копии.');
                if (records.length)
                    await tx.query('insert into private.recovery_transfer_metadata select $1,r.seq,r.size,r.sha256 from jsonb_to_recordset($2::jsonb) r(seq bigint,size int,sha256 text)', [id, JSON.stringify(records)]);
                if (records.length)
                    await tx.query('insert into private.recovery_snapshot_records select $1,r.seq,r.data from jsonb_to_recordset($2::jsonb) r(seq bigint,data jsonb)', [id, JSON.stringify(records)]);
                const pending = parts.filter(p => batch.kind === 'resources' || !records.some(r => r.seq === p.seq));
                if (pending.length)
                    await tx.query('insert into private.recovery_transfer_parts select $1,$2,p.seq,p.offset_bytes,p.bytes from jsonb_to_recordset($3::jsonb) p(seq bigint,offset_bytes int,bytes bytea)', [id, batch.kind, JSON.stringify(pending.map(p => ({
                            seq: p.seq, offset_bytes: p.offset, bytes: p.bytes
                        })))]);
                if (records.length)
                    await tx.query("delete from private.recovery_transfer_parts where id=$1 and kind='metadata' and seq=any($2::bigint[])", [id, records.map(r => r.seq)]);
                await tx.query("update private.recovery_snapshots set data=data||jsonb_build_object('metadataBytes',$2::bigint,'payloadBytes',$3::bigint,'objectStagingBytes',$4::bigint) where id=$1", [id, meta, payload, staging]);
                await tx.query('insert into private.recovery_transfer_receipts values($1,$2,$3,$4,$5,false)', [id, batch.cursor, batch.digest, batch.kind, {
                        seq, offset, pendingMetadata, completed: batch.items.filter(p => p.complete).map(p => p.seq)
                    }]);
                await tx.query("update private.recovery_transfers set data=data||jsonb_build_object('mappingDigest',$2::text) where id=$1", [id, mappingDigest]);
            });
        }
        const receipt = (await this.repo.pool.query('select * from private.recovery_transfer_receipts where id=$1 and cursor=$2', [id, batch.cursor])).rows[0];
        if (batch.kind === 'resources' && !receipt.complete) {
            if (!await this.finishObjects(actor, id, receipt.data.completed))
                return this.progress(state);
        }
        return this.repo.transaction(async (tx) => {
            state = await this.state(actor, id, tx);
            const receipt = (await tx.query('select * from private.recovery_transfer_receipts where id=$1 and cursor=$2 for update', [id, batch.cursor])).rows[0];
            if (!receipt || receipt.digest !== batch.digest || receipt.kind !== batch.kind)
                throw new AppError('CONFLICT', 'Подтверждение пакета изменено.');
            if (receipt.complete)
                return this.progress(state);
            if (state.phase !== 'staging' || this.progress(state).cursor !== batch.cursor)
                return bad('Курсор подтверждения пакета изменился.');
            if (batch.kind === 'metadata') {
                const next = receipt.data.seq === state.binding.records ? (await tx.query("select min(seq) seq from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000 and data->>'type'='file'", [id])).rows[0].seq : null;
                await tx.query("update private.recovery_transfers set metadata_seq=$2,data=data||jsonb_build_object('metadataOffset',$3::int,'metadataPending',$5::jsonb),resource_seq=case when $2=(binding->>'records')::bigint then $4 else resource_seq end where id=$1", [id, receipt.data.seq, receipt.data.offset, next ?? state.binding.records, receipt.data.pendingMetadata]);
            }
            else
                await tx.query('update private.recovery_transfers set resource_seq=$2,resource_offset=$3 where id=$1', [id, receipt.data.seq, receipt.data.offset]);
            await tx.query('update private.recovery_transfer_receipts set complete=true where id=$1 and cursor=$2', [id, batch.cursor]);
            const r = await this.renewTx(actor, id, tx);
            return this.progress(r.state);
        });
    }
    private async finishObjects(actor: Principal, id: string, sequences: number[]) {
        const token = randomUUID();
        const descriptors = await this.repo.transaction(async (tx) => {
            const s = await this.state(actor, id, tx);
            if (s.claim && s.claim_expires && new Date(s.claim_expires).getTime() > Date.now())
                throw new AppError('UNAVAILABLE', 'Проверка пакета уже выполняется.');
            const rows = (await tx.query("select r.seq,r.data from private.recovery_snapshot_records r where snapshot_id=$1 and seq=any($2::bigint[]) and not exists(select 1 from private.recovery_snapshot_records v where v.snapshot_id=r.snapshot_id and v.seq=4000000000+r.seq) order by r.seq", [id, sequences])).rows;
            if (!rows.length)
                return [];
            await tx.query("update private.recovery_transfers set claim=$2,claim_expires=clock_timestamp()+interval '60 seconds' where id=$1", [id, token]);
            const owned = rows.map(r => ({
                seq: Number(r.seq), key: r.data.root === 'catalog' ? 'private/catalog/restored/' + id + '/' + r.data.path : this.backup.remap(r.data.path, id), size: r.data.size, sha256: r.data.sha256
            }));
            await tx.query('insert into private.recovery_transfer_objects select $1,o.seq,o.key,o.size,o.sha256 from jsonb_to_recordset($2::jsonb) o(seq bigint,key text,size int,sha256 text) on conflict do nothing', [id, JSON.stringify(owned)]);
            return rows;
        });
        if (!descriptors.length)
            return true;
        try {
            const chunks = (await this.repo.pool.query("select seq,offset_bytes,bytes from private.recovery_transfer_parts where id=$1 and kind='resources' and seq=any($2::bigint[]) order by seq,offset_bytes", [id, descriptors.map(r => r.seq)])).rows;
            const known = (await this.repo.pool.query(verifiedPngProofQuery, [id, descriptors.map(r => r.data.sha256)])).rows;
            const png = new Set(known.map(r => r.hash)), done: {
                seq: number;
                data: any;
            }[] = [];
            let released = 0, at = 0;
            const started = performance.now();
            for (const saved of descriptors) {
                if (done.length && performance.now() - started > 10000)
                    break;
                const work = saved.data, seq = Number(saved.seq), buffers: Buffer[] = [];
                let size = 0;
                while (at < chunks.length && Number(chunks[at].seq) === seq) {
                    const part = chunks[at++];
                    if (part.offset_bytes !== size)
                        return bad('Часть объекта отсутствует.');
                    size += part.bytes.length;
                    if (size > work.size || buffers.length >= 1401)
                        return bad();
                    buffers.push(part.bytes);
                }
                const bytes = Buffer.concat(buffers);
                if (size !== work.size || sha(bytes) !== work.sha256)
                    return bad('Хэш объекта не совпадает.');
                const validation = work.root === 'object' && work.path.startsWith('private/validation/');
                if (validation && !png.has(work.sha256)) {
                    verifyValidationPng(bytes);
                    png.add(work.sha256);
                }
                const key = work.root === 'catalog' ? 'private/catalog/restored/' + id + '/' + work.path : this.backup.remap(work.path, id);
                try {
                    await this.backup.store.transport.put(key, bytes, work.mediaType, AbortSignal.timeout(20000));
                }
                catch {
                    const existing = await this.backup.store.transport.get(key, work.size, AbortSignal.timeout(20000));
                    if (existing.length !== size || sha(existing) !== work.sha256)
                        throw new AppError('CONFLICT', 'Подготовленный объект изменился.');
                }
                done.push({
                    seq: 4000000000 + seq, data: {
                        type: 'verified', source: work.path, key, size, sha256: work.sha256, sha1: createHash('sha1').update(bytes).digest('hex'), mediaType: work.mediaType, pngVerified: validation
                    }
                });
                released += size;
            }
            await this.repo.transaction(async (tx) => {
                await this.state(actor, id, tx);
                const claim = (await tx.query('select claim,claim_expires>clock_timestamp() live from private.recovery_transfers where id=$1', [id])).rows[0];
                if (claim.claim !== token || !claim.live)
                    throw new AppError('CONFLICT', 'Проверка объекта истекла.');
                if (done.length) {
                    await tx.query('insert into private.recovery_snapshot_records select $1,p.seq,p.data from jsonb_to_recordset($2::jsonb) p(seq bigint,data jsonb) on conflict do nothing', [id, JSON.stringify(done)]);
                    await tx.query("delete from private.recovery_transfer_parts where id=$1 and kind='resources' and seq=any($2::bigint[])", [id, done.map(r => r.seq - 4000000000)]);
                }
                await tx.query("update private.recovery_snapshots set data=jsonb_set(data,'{objectStagingBytes}',to_jsonb(greatest(0,coalesce((data->>'objectStagingBytes')::bigint,0)-$2::bigint))) where id=$1", [id, released]);
            });
            return done.length === descriptors.length;
        }
        finally {
            await this.repo.pool.query('update private.recovery_transfers set claim=null,claim_expires=null where id=$1 and claim=$2', [id, token]);
        }
    }
    async prepareBatch(actor: Principal, id: string): Promise<RecoveryPreparationProgress> {
        const token = randomUUID();
        let state = await this.repo.transaction(async (tx) => {
            const s = await this.state(actor, id, tx, 'freeze');
            if (s.phase === 'ready' || s.phase === 'committed')
                return s;
            if (s.phase === 'staging') {
                const stats = (await tx.query("select count(*) n,count(*) filter(where data->>'type'='file') files from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000", [id])).rows[0];
                const proofStats = (await tx.query("select count(*) n,count(distinct data->>'source') unique_n from private.recovery_snapshot_records where snapshot_id=$1 and seq>=4000000000 and seq<5000000000 and data->>'type'='verified'", [id])).rows[0], verified = Number(proofStats.n);
                if (verified !== Number(proofStats.unique_n))
                    return bad('Физические пути копии повторяются.');
                if (Number(stats.n) !== s.binding.records || verified !== Number(stats.files))
                    return bad('Передача копии ещё не завершена.');
            }
            if (s.claim && s.claim_expires && new Date(s.claim_expires).getTime() > Date.now())
                throw new AppError('UNAVAILABLE', 'Подготовка уже выполняется.');
            await tx.query("update private.recovery_transfers set phase=case when phase='staging' then 'preparing' else phase end,claim=$2,claim_expires=clock_timestamp()+interval '30 seconds' where id=$1", [id, token]);
            return {
                ...s, phase: s.phase === 'staging' ? 'preparing' : s.phase
            };
        });
        if (state.phase === 'ready' || state.phase === 'committed')
            return this.progress(state);
        try {
            const engine = new PostgresRestorePreparation(this.backup), previous = state.data.preparation ?? {
                after: -1, sites: 0, revisions: 0, fileCount: 0
            };
            let next: PreparationState, prepared: {
                seq: number;
                data: any;
            }[] = [];
            if (!previous.proofsUpgraded)
                next = await engine.upgradeProofs(actor, id, previous);
            else if (state.phase === 'validating')
                next = await engine.validate(actor, id, previous);
            else {
                const result = await engine.preparePage(actor, id, previous);
                if ('state' in result) {
                    next = result.state;
                    prepared = result.prepared ?? [];
                }
                else
                    next = result;
            }
            return await this.repo.transaction(async (tx) => {
                state = await this.state(actor, id, tx, 'verify');
                const claim = (await tx.query('select claim,claim_expires>clock_timestamp() live from private.recovery_transfers where id=$1', [id])).rows[0];
                if (claim.claim !== token || !claim.live)
                    throw new AppError('CONFLICT', 'Подготовка истекла.');
                if (prepared.length)
                    await tx.query('insert into private.recovery_snapshot_records select $1,p.seq,p.data from jsonb_to_recordset($2::jsonb) p(seq bigint,data jsonb) on conflict(snapshot_id,seq) do update set data=excluded.data', [id, JSON.stringify(prepared)]);
                await tx.query("update private.recovery_transfers set data=jsonb_set(data,'{preparation}',$2::jsonb),phase=$3 where id=$1", [id, next, next.final ? 'ready' : next.validation !== undefined ? 'validating' : 'preparing']);
                const r = await this.renewTx(actor, id, tx);
                return this.progress(r.state);
            });
        }
        finally {
            await this.repo.pool.query('update private.recovery_transfers set claim=null,claim_expires=null where id=$1 and claim=$2', [id, token]);
        }
    }
    async commitPrepared(actor: Principal, id: string) {
        const state = await this.repo.transaction(tx => this.state(actor, id, tx, 'verify'));
        if (!['ready', 'committed'].includes(state.phase))
            throw new AppError('CONFLICT', 'Подготовка восстановления ещё не завершена.');
        if (state.phase === 'committed')
            return {
                restoredSites: state.data.preparation.sites, restoredRevisions: state.data.preparation.revisions, targetId: id, quarantined: true, sourceUsers: Object.keys((await this.repo.transaction(tx => this.backup.snapshot(actor, id, tx))).data.verified), stagedRemnants: []
            };
        return new PostgresRestorePreparation(this.backup).commit(actor, id, state.data.preparation);
    }
    async cancel(actor: Principal, id: string) {
        await this.authorize(actor, id, undefined, true);
        await this.repo.transaction(async (tx) => {
            await this.backup.admin(actor, tx);
            const row = (await tx.query('select actor_id from private.recovery_snapshots where id=$1 for update', [id])).rows[0];
            if (!row)
                return;
            if (row.actor_id !== actor.userId)
                throw new AppError('NOT_FOUND', 'Другой сеанс.');
            await tx.query("update private.recovery_transfers set phase='cancelled' where id=$1 and phase<>'committed'", [id]);
            await tx.query('delete from private.payload_pins where id=$1', [id]);
            await tx.query("update private.recovery_snapshots set expires_at=clock_timestamp() where id=$1 and not exists(select 1 from private.recovery_transfers where id=$1 and phase='committed')", [id]);
        });
        await this.sweep();
        return {
            ok: true
        };
    }
    async sweep() {
        const started = performance.now();
        for (let page = 0; page < 64 && performance.now() - started < 10000; page++) {
            const row = (await this.repo.pool.query("select s.id from private.recovery_snapshots s left join private.recovery_transfers t on t.id=s.id where s.expires_at<=clock_timestamp() and coalesce(t.phase,'')<>'committed' and (t.claim_expires is null or t.claim_expires<=clock_timestamp()) order by s.expires_at limit 1")).rows[0];
            if (!row)
                return;
            const id = row.id;
            const objects = (await this.repo.pool.query("select seq,key from private.recovery_transfer_objects where id=$1 union all select seq-4000000000,data->>'key' from private.recovery_snapshot_records v where snapshot_id=$1 and seq>=4000000000 and seq<5000000000 and not exists(select 1 from private.recovery_transfer_objects o where o.id=$1 and o.seq=v.seq-4000000000) order by seq limit 64", [id])).rows;
            if (objects.length) {
                if (!this.backup.store.transport.delete)
                    throw new AppError('UNAVAILABLE', 'Для очистки подготовленных копий подключите удаление объектов.');
                const done: number[] = [];
                for (const o of objects) {
                    if (done.length && performance.now() - started > 10000)
                        break;
                    await this.backup.store.transport.delete(o.key, AbortSignal.timeout(20000));
                    done.push(Number(o.seq));
                }
                await this.repo.transaction(async (tx) => { await tx.query('delete from private.recovery_transfer_objects where id=$1 and seq=any($2::bigint[])', [id, done]); await tx.query('delete from private.recovery_snapshot_records where snapshot_id=$1 and seq=any($2::bigint[])', [id, done.map(n => n + 4000000000)]); });
                continue;
            }
            const removed = await this.repo.transaction(async (tx) => {
                await tx.query("set local statement_timeout='15s';set local work_mem='4MB'");
                let count = 0;
                for (const table of ['recovery_transfer_parts', 'recovery_transfer_metadata', 'recovery_transfer_inventory', 'recovery_transfer_catalog', 'recovery_transfer_receipts', 'recovery_snapshot_records']) {
                    const column = table === 'recovery_snapshot_records' ? 'snapshot_id' : 'id';
                    count += (await tx.query('with victims as(select ctid from private.' + table + ' where ' + column + '=$1 limit 256) delete from private.' + table + ' where ctid in(select ctid from victims)', [id])).rowCount ?? 0;
                }
                if (!count) {
                    await tx.query('delete from private.payload_pins where id=$1', [id]);
                    await tx.query('delete from private.recovery_transfers where id=$1', [id]);
                    await tx.query('delete from private.recovery_snapshots where id=$1', [id]);
                }
                return count;
            });
            if (!removed)
                continue;
        }
    }
}
