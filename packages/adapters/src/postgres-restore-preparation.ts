import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from '../../contracts/src/model.js';
import { AppError } from '../../contracts/src/model.js';
import type { RestoreReport } from '../../contracts/src/recovery.js';
import type { RecoveryRecord } from './recovery-records.js';
import { managedRecoveryTables, recoveryTables, monitoringRecoveryRow, validateLogicalRecoveryRecord } from './recovery-records.js';
import { SupabaseRepository, type SqlTransaction } from './supabase-repository.js';
import { checkArtifacts, artifactLimits } from '../../core/src/artifacts.js';
import { projectCheckpointFromFileDigests, parseCheckpointEvidence } from '../../core/src/usage.js';
import type { PostgresBackup } from './postgres-backup.js';
/** Server-derived facts for at most256 current input rows; returned facts have a separate1MiB bound. */
export const recoveryDependencyFactsQuery = "with asked as(select * from jsonb_to_recordset($2::jsonb) a(seq bigint,table_name text,row_id text,kind text,job_id text,available boolean)),facts as(\n select a.seq,jsonb_build_object('availability',av.state,'saved',ev.data,'source',src.row,'job',j.site_id) data from asked a\n left join lateral(select r.data#>>'{row,state}' state from private.recovery_snapshot_records r where a.table_name in ('private.artifacts','private.checkpoints') and r.snapshot_id=$1 and r.seq<1000000 and r.data->>'type'='row' and r.data->>'table'='private.payload_inventory' and r.data#>>'{row,id}'=a.row_id and r.data#>>'{row,kind}'=case a.table_name when 'private.artifacts' then 'artifact' else 'checkpoint' end limit 1) av on true\n left join lateral(select r.data#>'{row,data}' data from private.recovery_snapshot_records r where a.table_name='private.checkpoints' and r.snapshot_id=$1 and r.seq<1000000 and r.data->>'type'='row' and r.data->>'table'='private.checkpoint_evidence' and r.data#>>'{row,id}'=a.row_id limit 1) ev on true\n left join lateral(select r.data#>'{row}' row from private.recovery_snapshot_records r where a.table_name='private.payload_inventory' and a.available and a.kind in ('artifact','checkpoint') and r.snapshot_id=$1 and r.seq<1000000 and r.data->>'type'='row' and r.data->>'table'=case a.kind when 'artifact' then 'private.artifacts' else 'private.checkpoints' end and r.data#>>'{row,id}'=a.row_id limit 1) src on true\n left join lateral(select r.data#>>'{row,site_id}' site_id from private.recovery_snapshot_records r where a.table_name='private.payload_inventory' and a.available and a.kind='screenshot' and r.snapshot_id=$1 and r.seq<1000000 and r.data->>'type'='row' and r.data->>'table'='private.jobs' and r.data#>>'{row,id}'=a.job_id limit 1) j on true\n),bounded as(select seq,data,sum(octet_length(data::text)) over(order by seq) bytes from facts) select seq,data from bounded where bytes<=1048576 order by seq";
const schemas = new WeakMap<SupabaseRepository, Promise<Map<string, Set<string>>>>();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface PreparationState {
    after: number;
    proofsAfter?: number;
    proofsUpgraded?: boolean;
    sites: number;
    revisions: number;
    fileCount: number;
    validation?: number;
    inventoryAfter?: number;
    catalog?: {
        catalog: any[];
        catalogVersions: string[];
    };
    bundleAfter?: number;
    final?: any;
}
/** Existing typed transformations live here; each call owns one byte/count-bounded cohort. */
export class PostgresRestorePreparation {
    constructor(readonly backup: PostgresBackup) { }
    get repository() { return this.backup.repository; }
    get store() { return this.backup.store; }
    snapshot(actor: Principal, id: string, tx: SqlTransaction) { return this.backup.snapshot(actor, id, tx); }
    remap(key: string, id: string) { return this.backup.remap(key, id); }
    private async query(text: string, values?: any[]) {
        try {
            return await this.repository.transaction(async (tx) => { await tx.query("set local statement_timeout='15s';set local work_mem='4MB'"); return tx.query(text, values); });
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code === '57014')
                throw new AppError('NEEDS_ATTENTION', 'SQL-подготовка превысила15 секунд на запрос; повторите сверку.');
            throw error;
        }
    }
    private async activate<T>(action: (tx: SqlTransaction) => Promise<T>): Promise<T> {
        const tx = await this.repository.pool.connect();
        let open = false, destroy: Error | undefined;
        try {
            await tx.query('begin');
            open = true;
            await tx.query("set local lock_timeout='5s';set local statement_timeout='15s';set local work_mem='4MB'");
            await tx.query('select pg_advisory_xact_lock(73212,1)');
            const started = performance.now();
            const guard = () => {
                const remaining = 105000 - (performance.now() - started);
                if (remaining <= 0)
                    throw new AppError('NEEDS_ATTENTION', 'Атомарная установка превысила бюджет105 секунд; повторите сверку.');
                return Math.max(1, Math.floor(Math.min(15000, remaining)));
            };
            const bounded = new Proxy(tx, {
                get(target, key) {
                    if (key === 'query')
                        return async (...args: any[]) => { await tx.query("set local statement_timeout='" + guard() + "ms'"); const result = await (tx.query as any)(...args); guard(); return result; };
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
            const result = await action(bounded);
            await tx.query("set local statement_timeout='" + guard() + "ms'");
            await tx.query('commit');
            open = false;
            return result;
        }
        catch (error) {
            if (open)
                try {
                    await tx.query('rollback');
                }
                catch (rollback) {
                    destroy = rollback instanceof Error ? rollback : new Error('Restore rollback failed');
                }
            if ((error as {
                code?: string;
            }).code === '57014')
                throw new AppError('NEEDS_ATTENTION', 'SQL-установка превысила разрешённое время; исходная копия сохранена.');
            throw error;
        }
        finally {
            tx.release(destroy);
        }
    }
    private async validateTable(id: string, table: string) {
        const q = (name: string) => {
            if (!/^[a-z_][a-z0-9_]*$/.test(name))
                throw new AppError('NEEDS_ATTENTION', 'Неподдерживаемое поле схемы.');
            return '"' + name + '"';
        };
        const source = "with source as(select r.* from private.recovery_snapshot_records p cross join lateral jsonb_populate_record(null::" + table + ",(p.data->'row')||coalesce(p.data->'pointers','{}'::jsonb)) r where p.snapshot_id=$1 and p.seq>=6000000000 and p.data->>'table'=$2) ";
        const notnull = (await this.query("select a.attname from pg_attribute a where a.attrelid=$1::regclass and a.attnotnull and a.attnum>0 and not a.attisdropped", [table])).rows.map(r => q(r.attname) + ' is null');
        if (notnull.length && (await this.query(source + 'select 1 from source where ' + notnull.join(' or ') + ' limit 1', [id, table])).rowCount)
            throw new AppError('INVALID_INPUT', 'Обязательное поле копии отсутствует.');
        const constraints = (await this.query("select c.contype,pg_get_expr(c.conbin,c.conrelid) expression,ns.nspname||'.'||cl.relname target,array(select a.attname::text from unnest(c.conkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.n order by k.ord) columns,array(select a.attname::text from unnest(c.confkey) with ordinality k(n,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.n order by k.ord) targets from pg_constraint c left join pg_class cl on cl.oid=c.confrelid left join pg_namespace ns on ns.oid=cl.relnamespace where c.conrelid=$1::regclass and c.contype in ('f','c','p','u')", [table])).rows;
        for (const c of constraints) {
            if (c.contype === 'c') {
                if ((await this.query(source + 'select 1 from source where (' + c.expression + ') is false limit 1', [id, table])).rowCount)
                    throw new AppError('INVALID_INPUT', 'Запись копии не соответствует ограничениям схемы.');
            }
            else if (c.contype === 'p' || c.contype === 'u') {
                const columns = (c.columns as string[]).map(q);
                if ((await this.query(source + 'select 1 from source where ' + columns.map(col => col + ' is not null').join(' and ') + ' group by ' + columns.join(',') + ' having count(*)>1 limit 1', [id, table])).rowCount)
                    throw new AppError('INVALID_INPUT', 'Семантический идентификатор копии повторяется.');
            }
            else {
                const columns = c.columns as string[], targets = c.targets as string[], target = String(c.target);
                if (!(managedRecoveryTables as readonly string[]).includes(target) && target !== 'auth.users')
                    throw new AppError('NEEDS_ATTENTION', 'Связь схемы восстановления не поддерживается.');
                const nonnull = columns.map(col => 's.' + q(col) + ' is not null').join(' and ');
                const equal = targets.map((col, i) => "t.data#>>'{row," + col + "}'=s." + q(columns[i]!) + "::text").join(' and ');
                const staged = "exists(select 1 from private.recovery_snapshot_records t where t.snapshot_id=$1 and t.seq>=6000000000 and t.data->>'table'=$3 and " + equal + ')';
                const existing = (target === 'auth.users' || target === 'public.users') ? ' or exists(select 1 from ' + target + ' t where ' + targets.map((col, i) => 't.' + q(col) + '=s.' + q(columns[i]!)).join(' and ') + ')' : '';
                if ((await this.query(source + 'select 1 from source s where ' + nonnull + ' and not (' + staged + existing + ') limit 1', [id, table, target])).rowCount)
                    throw new AppError('INVALID_INPUT', 'Связанный объект копии отсутствует.');
            }
        }
    }
    async upgradeProofs(actor: Principal, id: string, state: PreparationState): Promise<PreparationState> {
        const rows = (await this.query("select v.seq,v.data,r.data descriptor from private.recovery_snapshot_records v join private.recovery_snapshot_records r on r.snapshot_id=v.snapshot_id and r.seq=v.seq-4000000000 where v.snapshot_id=$1 and v.seq>=4000000000 and v.seq<5000000000 and v.seq>$2 and v.data->>'type'='verified' and (v.data->>'sha1' is null or v.data->>'mediaType' is null) order by v.seq limit 64", [id, state.proofsAfter ?? 3999999999])).rows;
        if (!rows.length)
            return {
                ...state, proofsUpgraded: true
            };
        const started = performance.now();
        let size = 0, after = state.proofsAfter ?? 3999999999;
        for (const row of rows) {
            const p = row.data, f = row.descriptor;
            if (size && (size + f.size > 1048576 || performance.now() - started > 10000))
                break;
            if (f.type !== 'file' || p.source !== f.path || p.key !== (f.root === 'catalog' ? 'private/catalog/restored/' + id + '/' + f.path : this.remap(f.path, id)) || p.size !== f.size || p.sha256 !== f.sha256)
                throw new AppError('INVALID_INPUT', 'Физическое доказательство не соответствует описи.');
            const signal = AbortSignal.timeout(20000), bytes = await this.store.transport.get(p.key, f.size, signal), head = await this.store.transport.head(p.key, signal);
            if (bytes.length !== f.size || sha(bytes) !== f.sha256 || head.size !== f.size || head.mediaType !== f.mediaType)
                throw new AppError('INVALID_INPUT', 'Файл проверки повреждён.');
            await this.repository.transaction(async (tx) => {
                await this.snapshot(actor, id, tx);
                await tx.query('update private.recovery_snapshot_records set data=data||$3::jsonb where snapshot_id=$1 and seq=$2', [id, row.seq, {
                        sha1: createHash('sha1').update(bytes).digest('hex'), mediaType: head.mediaType
                    }]);
            });
            size += bytes.length;
            after = Number(row.seq);
        }
        return {
            ...state, proofsAfter: after
        };
    }
    async preparePage(actor: Principal, id: string, state: PreparationState) {
        const initial = {
            snapshot: await this.repository.transaction(tx => this.snapshot(actor, id, tx))
        };
        const mappings = initial.snapshot.data.verified as Record<string, {
            id: string;
            email: string;
        }>;
        let page = (await this.query("with sizes as(select r.seq,coalesce(m.size,octet_length(r.data::text)) n from private.recovery_snapshot_records r left join private.recovery_transfer_metadata m on m.id=r.snapshot_id and m.seq=r.seq where r.snapshot_id=$1 and r.seq>$2 and r.seq<1000000 and r.seq<=$2::bigint+256 order by r.seq limit 256), bounded as(select seq,sum(n) over(order by seq) bytes from sizes) select r.seq,r.data from bounded b join private.recovery_snapshot_records r on r.snapshot_id=$1 and r.seq=b.seq where b.bytes<=1048576 order by r.seq", [id, state.after])).rows;
        if (!page.length) {
            if (state.after + 1 !== initial.snapshot.data.records)
                throw new AppError('INVALID_INPUT', 'Позиция метаданных отсутствует.');
            await this.query("analyze private.recovery_snapshot_records");
            return {
                ...state, validation: 0
            };
        }
        const asked = page.map(saved => {
            const r = saved.data.row ?? {};
            return {
                seq: Number(saved.seq), table_name: saved.data.table ?? null, row_id: r.id ?? null, kind: r.kind ?? null, job_id: r.data?.producer?.jobId ?? null, available: r.state === 'available'
            };
        });
        const facts = (await this.query(recoveryDependencyFactsQuery, [id, JSON.stringify(asked)])).rows;
        if (!facts.length)
            throw new AppError('INVALID_INPUT', 'Факты записи превышают лимит подготовки.');
        for (let n = 0; n < facts.length; n++)
            if (Number(facts[n].seq) !== Number(page[n]?.seq))
                throw new AppError('INVALID_INPUT', 'Факты метаданных неполны.');
        page = page.slice(0, facts.length);
        const byOrdinal = new Map(facts.map(r => [Number(r.seq), r.data]));
        // Key references cannot exceed the serialized cohort. Only matching immutable proofs are hydrated.
        const references = new Set<string>();
        const visit = (v: any): void => {
            if (typeof v === 'string' && v.startsWith('private/'))
                references.add(v);
            else if (Array.isArray(v))
                v.forEach(visit);
            else if (v && typeof v === 'object')
                Object.values(v).forEach(visit);
        };
        page.forEach(r => visit(r.data));
        const proofs = (await this.query("select data from private.recovery_snapshot_records where snapshot_id=$1 and data->>'type'='verified' and data->>'source'=any($2::text[])", [id, [...references]])).rows;
        const bySource = new Map(proofs.map(r => [r.data.source, r.data]));
        // Catalog paths do not have a private/ prefix; a cohort's descriptor lookups remain bounded.
        for (const r of page)
            if (r.data.type === 'file' && !bySource.has(r.data.path)) {
                const p = (await this.query("select data from private.recovery_snapshot_records where snapshot_id=$1 and data->>'type'='verified' and data->>'source'=$2", [id, r.data.path])).rows[0];
                if (p)
                    bySource.set(r.data.path, p.data);
            }
        const keys = {
            get: async (source: string) => bySource.get(source)
        };
        let cached = schemas.get(this.repository);
        if (!cached) {
            cached = this.query("select table_schema,table_name,column_name from information_schema.columns where table_schema in ('public','private')").then(result => {
                const map = new Map<string, Set<string>>();
                for (const r of result.rows) {
                    const table = r.table_schema + '.' + r.table_name;
                    if (!map.has(table))
                        map.set(table, new Set());
                    map.get(table)!.add(r.column_name);
                }
                return map;
            });
            schemas.set(this.repository, cached);
            cached.catch(() => schemas.delete(this.repository));
        }
        const schema = await cached;
        let revisions = state.revisions, sites = state.sites, seen = state.after + 1, fileCount = state.fileCount, after = state.after, processed = 0;
        const started = performance.now();
        const prepared: {
            seq: number;
            data: any;
        }[] = [];
        const identityColumns: Record<string, string[]> = {
            'public.sites': ['owner_id'], 'public.memberships': ['user_id'], 'public.assignments': ['user_id'], 'private.batches': ['owner_id'], 'private.batch_assignments': ['user_id'], 'private.import_resources': ['owner_id'], 'private.workers': ['enrollment_actor'], 'private.audit': ['actor_id']
        };
        const remapFile = async (file: any, required: boolean) => {
            const mapped = await keys.get(file.objectKey);
            if (!mapped) {
                if (required)
                    throw new AppError('INVALID_INPUT', 'Обязательное содержимое копии отсутствует.');
                file.objectKey = this.remap(file.objectKey, id);
                return;
            }
            if (mapped.size !== file.size || mapped.sha256 !== file.sha256)
                throw new AppError('INVALID_INPUT', 'Опись содержимого не совпадает с метаданными.');
            file.objectKey = mapped.key;
        };
        for (const saved of page) {
            const seq = Number(saved.seq);
            if (seq !== seen++)
                throw new AppError('INVALID_INPUT', 'Запись отсутствует.');
            if (performance.now() - started > 10000 && processed)
                break;
            after = seq;
            processed++;
            const record = saved.data as RecoveryRecord, fact = byOrdinal.get(seq)!;
            if (record.type === 'header') {
                if (seq !== 0 || record.adapter !== 'managed' || record.schema !== initial.snapshot.data.header.schema || record.version !== 1 || record.sourceId !== initial.snapshot.data.header.sourceId)
                    throw new AppError('INVALID_INPUT', 'Неверный источник копии.');
                continue;
            }
            if (record.type === 'file') {
                const mapped = await keys.get(record.path);
                if (!mapped || mapped.size !== record.size || mapped.sha256 !== record.sha256)
                    throw new AppError('INVALID_INPUT', 'Объект ещё не проверен.');
                fileCount++;
                continue;
            }
            if (record.type !== 'row' || !recoveryTables('managed',initial.snapshot.data.header.schema).includes(record.table))
                throw new AppError('INVALID_INPUT', 'Неизвестная запись копии.');
            validateLogicalRecoveryRecord(record,initial.snapshot.data.header.schema);
            const row = monitoringRecoveryRow(record.table,record.row,true) as Record<string, any>, table = record.table, columns = schema.get(table);
            if (!columns || Object.keys(row).some(key => !columns.has(key)))
                throw new AppError('INVALID_INPUT', 'Неизвестное поле метаданных.');
            for (const key of identityColumns[table] ?? [])
                if (row[key]) {
                    const mapped = mappings[row[key]];
                    if (!mapped)
                        throw new AppError('INVALID_INPUT', 'Не задан подтверждённый пользователь назначения: ' + table + '.' + key + '.');
                    row[key] = mapped.id;
                }
            const pointers: Record<string, unknown> = {};
            if (table === 'public.users') {
                const identity = mappings[row.id];
                if (!identity)
                    throw new AppError('INVALID_INPUT', 'Пользователь не привязан.');
                row.id = identity.id;
                row.email = identity.email;
            }
            if (table === 'public.sites') {
                sites++;
                pointers.draft_id = row.draft_id;
                pointers.published_id = row.published_id;
                row.draft_id = null;
                row.published_id = null;
            }
            if (table === 'public.revisions')
                revisions++;
            if (table === 'private.import_resources' && row.data.complete) {
                const availability = (await this.query("select data#>>'{row,state}' state from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000 and data->>'table'='private.payload_inventory' and data#>>'{row,kind}'='resource' and data#>>'{row,id}'=$2", [id, row.id])).rows[0]?.state;
                if (availability !== 'deleted' && availability !== 'claimed') {
                    const stats = (await this.query("select count(*) n,coalesce(sum((length(data#>>'{row,bytes}')-2)/2),0) size from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000 and data->>'table'='private.import_chunks' and data#>>'{row,resource_id}'=$2", [id, row.id])).rows[0];
                    if (Number(stats.n) > 700 || Number(stats.size) !== row.data.size || row.data.size > 16 * 1024 ** 2)
                        throw new AppError('INVALID_INPUT', 'Состав импорта повреждён.');
                    const chunks = (await this.query("select data#>'{row}' row from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000 and data->>'table'='private.import_chunks' and data#>>'{row,resource_id}'=$2 order by (data#>>'{row,part}')::int", [id, row.id])).rows, hash = createHash('sha256');
                    for (const [index, c] of chunks.entries()) {
                        if (c.row.part !== index)
                            throw new AppError('INVALID_INPUT', 'Фрагмент импорта отсутствует.');
                        hash.update(Buffer.from(c.row.bytes.slice(2), 'hex'));
                    }
                    if (hash.digest('hex') !== row.data.sha256)
                        throw new AppError('INVALID_INPUT', 'Хэш импорта не совпадает.');
                }
            }
            if (table === 'private.workers') {
                row.token_hash = sha(randomBytes(32));
                row.revoked_at = new Date().toISOString();
                row.paused = true;
                row.last_heartbeat = null;
            }
            if (table === 'private.jobs') {
                pointers.original = {
                    worker_id: row.worker_id, expires_at: row.expires_at, generation: row.generation, state: row.data.state
                };
                row.worker_id = null;
                row.expires_at = null;
                row.generation = Number(row.generation) + 1;
                row.data.state = ['completed', 'cancelled'].includes(row.data.state) ? row.data.state : 'paused';
                pointers.checkpoint_id = row.checkpoint_id;
                pointers.data = structuredClone(row.data);
                row.checkpoint_id = null;
                row.data.checkpointId = null;
            }
            if (table === 'private.site_operations') {
                if (row.kind === 'controller')
                    continue;
                row.expires_at = null;
                row.generation = null;
            }
            if (table === 'private.edit_requests' && row.data.visualSave?.actorId) {
                const identity = mappings[row.data.visualSave.actorId];
                if (!identity)
                    throw new AppError('INVALID_INPUT', 'Автор Save не привязан.');
                row.data.visualSave.actorId = identity.id;
            }
            if (['private.artifacts', 'private.checkpoints'].includes(table)) {
                const kind = table === 'private.artifacts' ? 'artifact' : 'checkpoint', availability = fact.availability ?? undefined, required = availability === undefined || availability === 'available';
                const manifest = table === 'private.artifacts' ? row.manifest : row.metadata.manifest;
                if (!manifest || manifest.id !== row.id || manifest.siteId !== row.site_id || !Array.isArray(manifest.files) || manifest.files.length > 100)
                    throw new AppError('INVALID_INPUT', 'Привязка артефакта повреждена.');
                checkArtifacts(manifest.files.map((f: any) => ({
                    path: f.path, mediaType: f.mediaType, bytes: new Uint8Array()
                })));
                if (manifest.files.reduce((n: number, f: any) => n + f.size, 0) > artifactLimits.totalBytes || manifest.files.some((f: any) => !Number.isSafeInteger(f.size) || f.size < 0 || f.size > artifactLimits.fileBytes || !/^[a-f0-9]{64}$/.test(f.sha256) || !/^[a-f0-9]{40}$/.test(f.sha1) || typeof f.objectKey !== 'string' || !f.objectKey.startsWith('private/' + (kind === 'artifact' ? 'artifacts' : 'checkpoints') + '/' + row.site_id + '/' + row.id + '/')))
                    throw new AppError('INVALID_INPUT', 'Физическая привязка артефакта повреждена.');
                if (table === 'private.checkpoints' && required) {
                    const c = row.metadata.checkpoint, stateFile = row.metadata.state;
                    if (!c || c.id !== row.id || c.jobId !== row.job_id || c.manifestId !== row.manifest_id || !stateFile || c.stateKey !== stateFile.objectKey)
                        throw new AppError('INVALID_INPUT', 'Привязка контрольной точки повреждена.');
                    const proof = async (f: any) => {
                        const physical = await keys.get(f.objectKey);
                        if (!physical || physical.source !== f.objectKey || physical.key !== this.remap(f.objectKey, id) || physical.size !== f.size || physical.sha256 !== f.sha256 || physical.sha1 !== f.sha1 || physical.mediaType !== f.mediaType)
                            throw new AppError('INVALID_INPUT', 'Доказательство файла не соответствует описи.');
                        return physical;
                    };
                    const read = async (f: any) => {
                        const physical = await proof(f);
                        if (!physical)
                            throw new AppError('INVALID_INPUT', 'Файл проверки отсутствует.');
                        const bytes = await this.store.transport.get(physical.key, f.size, AbortSignal.timeout(20000));
                        if (bytes.length !== f.size || sha(bytes) !== f.sha256 || createHash('sha1').update(bytes).digest('hex') !== f.sha1)
                            throw new AppError('INVALID_INPUT', 'Файл проверки повреждён.');
                        return bytes;
                    }, state = JSON.parse(new TextDecoder('utf8', {
                        fatal: true
                    }).decode(await read(stateFile)));
                    if (state.siteId !== row.site_id || state.jobId !== row.job_id || state.manifestId !== undefined && state.manifestId !== row.manifest_id)
                        throw new AppError('INVALID_INPUT', 'Состояние принадлежит другому заданию.');
                    const files = [];
                    for (const f of manifest.files) {
                        const physical = await proof(f);
                        files.push({
                            path: f.path, mediaType: physical.mediaType, size: physical.size, sha256: physical.sha256
                        });
                    }
                    const projected = projectCheckpointFromFileDigests(c, state, files, row.expected_checkpoint_id), saved = fact.saved;
                    if (saved && parseCheckpointEvidence(saved).digest !== projected.evidence.digest)
                        throw new AppError('INVALID_INPUT', 'Свидетельство не соответствует сохранённым байтам.');
                }
                if (table === 'private.artifacts') {
                    for (const file of row.manifest.files)
                        await remapFile(file, required);
                }
                else {
                    const metadata = row.metadata, sourceKey = metadata.checkpoint.stateKey;
                    for (const file of metadata.manifest.files)
                        await remapFile(file, required);
                    if (metadata.state)
                        await remapFile(metadata.state, required);
                    const mappedState = await keys.get(sourceKey);
                    if (mappedState)
                        metadata.checkpoint.stateKey = mappedState.key;
                }
            }
            if (table === 'private.upload_preparations') {
                for (const file of row.metadata.manifest?.files ?? [])
                    await remapFile(file, false);
                if (row.metadata.state)
                    await remapFile(row.metadata.state, false);
                if (row.metadata.checkpoint?.stateKey) {
                    const mapped = await keys.get(row.metadata.checkpoint.stateKey);
                    if (mapped)
                        row.metadata.checkpoint.stateKey = mapped.key;
                }
                ;
            }
            if (table === 'private.payload_inventory') {
                if (row.state === 'available' && ['artifact', 'checkpoint'].includes(row.kind)) {
                    const saved = fact.source;
                    if (!saved || saved.site_id !== row.site_id)
                        throw new AppError('INVALID_INPUT', 'Опись принадлежит другому сайту.');
                    const manifest = row.kind === 'artifact' ? saved.manifest : saved.metadata.manifest, expected = [...manifest.files, ...(row.kind === 'checkpoint' ? [saved.metadata.state] : [])];
                    if (expected.length !== row.data.objects.length || expected.some((f: any, index: number) => { const o = row.data.objects[index]; return f.objectKey !== o.key || f.size !== o.size || f.sha256 !== o.sha256 || f.mediaType !== o.mediaType; }))
                        throw new AppError('INVALID_INPUT', 'Состав описи не соответствует неизменяемым метаданным.');
                }
                if (row.state === 'available' && row.kind === 'screenshot') {
                    const producer = row.data.producer, job = producer && fact.job ? {
                        site_id: fact.job
                    } : null;
                    if (!job || job.site_id !== row.site_id || row.data.objects.length !== 1 || row.data.objects[0].mediaType !== 'image/png' || !row.data.objects[0].key.startsWith('private/validation/' + row.site_id + '/'))
                        throw new AppError('INVALID_INPUT', 'Производитель снимка повреждён.');
                }
                const sourceObjects = structuredClone(row.data.objects ?? []);
                for (const file of row.data.objects ?? []) {
                    const mapped = await keys.get(file.key);
                    if (!mapped && row.state === 'available' && row.kind !== 'resource')
                        throw new AppError('INVALID_INPUT', 'Обязательная физическая опись отсутствует.');
                    if (!mapped && row.state === 'staging' && row.kind !== 'resource')
                        file.key = this.remap(file.key, id);
                    if (mapped) {
                        if (mapped.size !== file.size || mapped.sha256 !== file.sha256)
                            throw new AppError('INVALID_INPUT', 'Физическая опись повреждена.');
                        file.key = mapped.key;
                    }
                }
                row.data.originalObjects ??= row.data.sourceObjects ?? sourceObjects;
                row.data.sourceObjects = sourceObjects;
                row.data.sourceInstallation = initial.snapshot.data.header.sourceId;
                row.first_orphan_at = null;
                row.claim_token = null;
                if (row.state === 'claimed')
                    row.state = 'deleted';
            }
            if (table === 'private.provider_accounts' || table === 'private.provider_publications') {
                row.step_token = null;
                row.step_expires = null;
            }
            if (table === 'private.recovery_state') {
                if (row.key === 'catalog' || String(row.key).startsWith('catalog:')) {
                    const state = (await this.query("select data#>>'{row,state}' state from private.recovery_snapshot_records where snapshot_id=$1 and seq<1000000 and data->>'table'='private.payload_inventory' and data#>>'{row,kind}'='catalog' and data#>>'{row,id}'=$2", [id, 'restore-' + String(row.key).slice(8)])).rows[0]?.state;
                    if (!['claimed', 'deleted'].includes(state)) {
                        for (const file of row.data.files ?? []) {
                            const mapped = await keys.get(file.key);
                            if (!mapped || mapped.sha256 !== file.sha256 || mapped.size !== file.size)
                                throw new AppError('INVALID_INPUT', 'Закреплённый каталог отсутствует.');
                            file.key = mapped.key;
                        }
                    }
                    else
                        pointers.prunedCatalog = true;
                }
                else if (row.key === 'installed-catalog') {
                    if (!Array.isArray(row.data.versions) || row.data.versions.length > 10000 || row.data.versions.some((v: unknown) => typeof v !== 'string'))
                        throw new AppError('INVALID_INPUT', 'Текущий каталог повреждён.');
                }
                else
                    row.key = 'provenance:' + initial.snapshot.data.header.sourceId + ':' + row.key;
            }
            prepared.push({
                seq: 6000000000 + seq, data: {
                    type: 'prepared', table, row, pointers
                }
            });
        }
        return {
            state: {
                ...state, after, sites, revisions, fileCount
            }, prepared
        };
    }
    async validate(actor: Principal, id: string, state: PreparationState): Promise<PreparationState> {
        const snapshot = await this.repository.transaction(tx => this.snapshot(actor, id, tx));
        if ((state.validation ?? 0) === 0) {
            const stats = (await this.query("select count(*) n,count(distinct data->>'source') unique_n from private.recovery_snapshot_records where snapshot_id=$1 and seq>=4000000000 and seq<5000000000 and data->>'type'='verified'", [id])).rows[0];
            if (Number(stats.n) !== state.fileCount || stats.n !== stats.unique_n)
                throw new AppError('INVALID_INPUT', 'Состав объектов не совпадает с копией.');
        }
        const index = state.validation ?? 0,tables=recoveryTables('managed',snapshot.data.header.schema);
        if (index < tables.length) {
            const table = tables[index]!;
            // Cast all prepared rows against actual fixed server schema before activation.
            await this.query('select count(jsonb_populate_record(null::' + table + ",data->'row')) from private.recovery_snapshot_records where snapshot_id=$1 and seq>=6000000000 and data->>'table'=$2", [id, table]);
            await this.validateTable(id, table);
            if (table === 'private.checkpoints' || table === 'public.revisions') {
                const parent = table === 'public.revisions' ? 'parent_id' : 'expected_checkpoint_id';
                const result = await this.query("with recursive source as(select seq,data->'row' row from private.recovery_snapshot_records where snapshot_id=$1 and seq>=6000000000 and data->>'table'=$2),tree as(select seq,row,0 depth from source where row->>'" + parent + "' is null union all select s.seq,s.row,t.depth+1 from source s join tree t on s.row->>'" + parent + "'=t.row->>'id' where t.depth<1000000),updated as(update private.recovery_snapshot_records r set data=r.data||jsonb_build_object('depth',t.depth) from tree t where r.snapshot_id=$1 and r.seq=t.seq returning r.seq) select (select count(*) from source) total,(select count(*) from updated) reachable", [id, table]);
                if (result.rows[0].total !== result.rows[0].reachable)
                    throw new AppError('INVALID_INPUT', 'Цикл предшественников.');
            }
            return {
                ...state, validation: index + 1
            };
        }
        if (snapshot.data.inventoryDigest) {
            const after = state.inventoryAfter ?? -1;
            const rows = (await this.query('select seq,size,sha256 from private.recovery_transfer_metadata where id=$1 and seq>$2 order by seq limit 256', [id, after])).rows;
            if (rows.length) {
                const digest = createHash('sha256');
                let expected = after + 1;
                for (const r of rows) {
                    if (Number(r.seq) !== expected++)
                        throw new AppError('INVALID_INPUT', 'Опись метаданных неполна.');
                    digest.update(JSON.stringify([Number(r.seq), r.size, r.sha256]) + '\n');
                }
                await this.repository.transaction(async (tx) => { await this.snapshot(actor, id, tx); await tx.query('insert into private.recovery_transfer_inventory values($1,$2,$3) on conflict do nothing', [id, Math.floor((after + 1) / 256), digest.digest('hex')]); });
                return {
                    ...state, inventoryAfter: expected - 1
                };
            }
            if (after + 1 !== snapshot.data.records)
                throw new AppError('INVALID_INPUT', 'Опись метаданных неполна.');
            // <=3907 fixed digests (1M records /256), <=250048B SQL aggregate, never whole records.
            const root = (await this.query("select encode(sha256(convert_to(string_agg(digest,'' order by page),'UTF8')),'hex') digest from private.recovery_transfer_inventory where id=$1", [id])).rows[0]?.digest;
            if (root !== snapshot.data.inventoryDigest)
                throw new AppError('INVALID_INPUT', 'Хэш полной описи не совпадает.');
        }
        if (!state.catalog) {
            const catalogRows = (await this.query("select r.data->>'path' path,v.data from private.recovery_snapshot_records r join private.recovery_snapshot_records v on v.snapshot_id=r.snapshot_id and v.data->>'type'='verified' and v.data->>'source'=r.data->>'path' where r.snapshot_id=$1 and r.seq<1000000 and r.data->>'type'='file' and r.data->>'root'='catalog' order by r.seq limit 10001", [id])).rows;
            if (catalogRows.length > 10000)
                throw new AppError('INVALID_INPUT', 'Слишком много файлов каталога.');
            const catalog = catalogRows.map(r => ({
                path: r.path, key: r.data.key, size: r.data.size, sha256: r.data.sha256
            }));
            const catalogVersions = catalog.length ? await this.backup.verifyCatalog(catalog) : [];
            if (catalogVersions.length)
                await this.query('insert into private.recovery_transfer_catalog select $1,unnest($2::text[]) on conflict do nothing', [id, catalogVersions]);
            return {
                ...state, catalog: {
                    catalog, catalogVersions
                }, bundleAfter: 6000000000
            };
        }
        const bundle = (await this.query("select seq,data#>'{row,data}' bundle from private.recovery_snapshot_records where snapshot_id=$1 and seq>$2 and data->>'table'='private.recovery_state' and coalesce(data#>>'{pointers,prunedCatalog}','false')='false' and (data#>>'{row,key}'='catalog' or data#>>'{row,key}' like 'catalog:%') order by seq limit 1", [id, state.bundleAfter ?? 6000000000])).rows[0];
        if (bundle) {
            const verified = await this.backup.verifyCatalog(bundle.bundle.files);
            if (!Array.isArray(bundle.bundle.versions) || bundle.bundle.versions.some((v: string) => !verified.includes(v)))
                throw new AppError('INVALID_INPUT', 'Версия каталога не подтверждена.');
            if (verified.length)
                await this.query('insert into private.recovery_transfer_catalog select $1,unnest($2::text[]) on conflict do nothing', [id, verified]);
            return {
                ...state, bundleAfter: Number(bundle.seq)
            };
        }
        const installed = (await this.query("select data#>'{row,data,versions}' versions from private.recovery_snapshot_records where snapshot_id=$1 and seq>=6000000000 and data->>'table'='private.recovery_state' and data#>>'{row,key}'='installed-catalog'", [id])).rows[0]?.versions;
        const required = snapshot.data.header.pinnedCatalogs ?? [];
        if (!Array.isArray(required) || required.length > 10000 || !Array.isArray(installed) || installed.length > 10000)
            throw new AppError('INVALID_INPUT', 'Опись версий каталога повреждена.');
        if ((await this.query('select 1 from unnest($2::text[]) v where not exists(select 1 from private.recovery_transfer_catalog c where c.id=$1 and c.version=v) limit 1', [id, [...required, ...installed]])).rowCount)
            throw new AppError('INVALID_INPUT', 'Закреплённый или установленный каталог отсутствует в копии.');
        return {
            ...state, final: state.catalog
        };
    }
    async commit(actor: Principal, id: string, state: PreparationState): Promise<RestoreReport> {
        const initial = {
            snapshot: await this.repository.transaction(tx => this.snapshot(actor, id, tx))
        };
        const mappings = initial.snapshot.data.verified as Record<string, {
            id: string;
            email: string;
        }>;
        const mappingDigest = sha(Buffer.from(JSON.stringify(mappings)));
        const { sites, revisions } = state, { catalog, catalogVersions } = state.final;
        const order = ['public.users', 'public.memberships', 'public.sites', 'private.batches', 'private.workers', 'private.jobs', 'private.artifacts', 'private.checkpoints', 'public.revisions', 'public.assignments', 'private.edit_requests', 'public.chat', 'private.deployments', 'public.health', 'private.batch_rows', 'private.batch_assignments', 'private.import_resources', 'private.import_chunks', 'private.publication_reservations', 'private.site_operations', 'private.provider_accounts', 'private.provider_publications', 'private.publication_attempts', 'private.upload_preparations', 'private.catalog', 'private.audit', 'private.payload_inventory', 'private.payload_edges', 'private.checkpoint_evidence', 'private.job_usage','private.job_activity','private.health_observations', 'private.recovery_state'];
        await this.activate(async (tx) => {
            await this.snapshot(actor, id, tx);
            await tx.query("set local lock_timeout='5s';set local statement_timeout='15s';set local work_mem='4MB'");
            const ready = (await tx.query("select t.phase,t.data,((t.data->>'mappingDigest')=$2 and (s.data->'verified')=$3::jsonb) mappings_match from private.recovery_transfers t join private.recovery_snapshots s on s.id=t.id where t.id=$1 for update of t", [id, mappingDigest, mappings])).rows[0];
            if (ready?.mappings_match !== true)
                throw new AppError('CONFLICT', 'Привязки Auth не совпадают с закреплённой подготовкой.');
            if (ready?.phase === 'committed')
                return;
            if (ready?.phase !== 'ready')
                throw new AppError('CONFLICT', 'Подготовка восстановления ещё не завершена.');
            if ((await tx.query('select 1 from public.sites union all select 1 from private.jobs union all select 1 from private.artifacts limit 1')).rowCount)
                throw new AppError('CONFLICT', 'Цель перестала быть пустой.');
            await tx.query("select set_config('site_factory.restore','1',true),set_config('site_factory.restore_import','1',true)");
            for (const table of order) {
                const conflict = table === 'public.users' || table === 'public.memberships' ? ' on conflict do nothing' : '', source = "select data->'row' row,coalesce((data->>'depth')::int,0) depth from private.recovery_snapshot_records where snapshot_id=$1 and seq>=6000000000 and data->>'table'=$2";
                await tx.query('insert into ' + table + (table === 'private.audit' ? ' overriding system value' : '') + ' select (jsonb_populate_record(null::' + table + ',row)).* from (' + source + ') s order by depth' + conflict, [id, table]);
            }
            await tx.query("update public.sites s set draft_id=(p.data#>>'{pointers,draft_id}')::uuid,published_id=(p.data#>>'{pointers,published_id}')::uuid from private.recovery_snapshot_records p where p.snapshot_id=$1 and p.seq>=6000000000 and p.data->>'table'='public.sites' and s.id=(p.data#>>'{row,id}')::uuid", [id]);
            await tx.query("update private.jobs j set checkpoint_id=(p.data#>>'{pointers,checkpoint_id}')::uuid,data=p.data#>'{pointers,data}' from private.recovery_snapshot_records p where p.snapshot_id=$1 and p.seq>=6000000000 and p.data->>'table'='private.jobs' and j.id=(p.data#>>'{row,id}')::uuid", [id]);
            if (catalog.length) {
                await tx.query('insert into private.recovery_state values($1,$2)', ['catalog:' + id, {
                        sourceId: initial.snapshot.data.header.sourceId, files: catalog, versions: catalogVersions
                    }]);
                await tx.query('insert into private.payload_inventory values($1,$2,null,$3,$4,null,null)', ['catalog', 'restore-' + id, {
                        kind: 'catalog', id: 'restore-' + id, siteId: null, objects: catalog.map((f: any) => ({
                            key: f.key, size: f.size, sha256: f.sha256, mediaType: 'application/octet-stream'
                        })), createdAt: Date.now(), protectUntil: 0, state: 'available', firstOrphanAt: null, claimToken: null
                    }, 'available']);
                await tx.query("insert into private.payload_edges select 'catalog',version,'retained','catalog',$2 from unnest($1::text[]) versions(version) on conflict do nothing", [catalogVersions, 'restore-' + id]);
            }
            await tx.query("select setval('private.publication_settled_sequence',coalesce((select max(settled_seq) from private.provider_publications),0)+1,false)");
            await tx.query("select setval(pg_get_serial_sequence('private.audit','id'),coalesce((select max(id) from private.audit),0)+1,false)");
            await tx.query('insert into private.recovery_state values($1,$2)', ['installation', {
                    restoreId: id, sourceId: initial.snapshot.data.header.sourceId, restoredAt: Date.now(), authMapping: Object.fromEntries(Object.entries(mappings).map(([source, destination]) => [source, destination.id]))
                }]);
            await tx.query('insert into private.recovery_state values($1,$2)', ['quarantine', {
                    sourceId: initial.snapshot.data.header.sourceId, mappings, restoreId: id, sites, revisions, physicalProvenanceSnapshot: id, providerReconciliationRequired: true
                }]);
            await tx.query("update private.recovery_transfers set phase='committed' where id=$1", [id]);
        });
        return {
            restoredSites: sites, restoredRevisions: revisions, targetId: id, quarantined: true, sourceUsers: Object.keys(mappings), stagedRemnants: []
        };
    }
}
