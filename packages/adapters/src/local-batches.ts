import { randomUUID, createHash } from 'node:crypto';
import { AppError } from '../../contracts/src/model.js';
import type { Principal, Site, Job } from '../../contracts/src/model.js';
import type { ImportRow, ImportRowView, ImportSummary, RowIssue } from '../../contracts/src/import.js';
import { importLimits } from '../../contracts/src/import.js';
import { parseSiteInput } from '../../contracts/src/inputs.js';
import { authorize } from '../../core/src/permissions.js';
import { validateRows } from '../../core/src/import/rows.js';
import { insertLocalSite, insertLocalJob, type LocalDatabase } from './local-database.js';
export type LocalDraft = {
    summary: ImportSummary;
    assignedUserIds: string[];
    hash: string;
    committedRevision?: number;
};
export class LocalBatches {
    constructor(readonly db: LocalDatabase) { }
    async assign(actor: Principal, id: string, value: unknown) {
        this.db.transaction(() => {
            authorize(actor, 'admin:manage');
            this.read(actor, id, true);
            if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 160))
                throw new AppError('INVALID_INPUT', 'Некорректные назначения.');
            this.db.sql.prepare('delete from batch_assignments where batch_id=?').run(id);
            for (const userId of new Set(value))
                this.db.sql.prepare('insert into batch_assignments values(?,?)').run(id, userId);
        });
    }
    read(actor: Principal, id: string, manage = false): LocalDraft {
        authorize(actor, 'site:create');
        const row = this.db.sql.prepare('select owner_id,data from batches where id=?').get(id);
        if (!row)
            throw new AppError('NOT_FOUND', 'Пачка не найдена.');
        const draft = JSON.parse(String(row.data)) as LocalDraft;
        if (actor.role !== 'admin' && row.owner_id !== actor.userId && (manage || !this.db.sql.prepare('select 1 from batch_assignments where batch_id=? and user_id=?').get(id, actor.userId)))
            throw new AppError(manage ? 'FORBIDDEN' : 'NOT_FOUND', 'Нет доступа к пачке.');
        return draft;
    }
    save(draft: LocalDraft) { this.db.sql.prepare('update batches set data=?,state=? where id=?').run(JSON.stringify(draft), draft.summary.state, draft.summary.id); }
    rows(id: string): ImportRowView[] { return this.db.sql.prepare('select data from batch_rows where batch_id=? order by row_number').all(id).map(r => JSON.parse(String(r.data)) as ImportRowView); }
    putRow(id: string, row: ImportRowView) { this.db.sql.prepare('insert into batch_rows values(?,?,?,?) on conflict(batch_id,row_number) do update set data=excluded.data,site_id=excluded.site_id').run(id, row.rowNumber, JSON.stringify(row), row.siteId); }
    async submitBatch(actor: Principal, inputs: ImportRow[], requestKey: string) {
        authorize(actor, 'site:create');
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestKey) || inputs.length > importLimits.rows || new Set(inputs.map(r => r.rowNumber)).size !== inputs.length || inputs.some(r => !Number.isInteger(r.rowNumber) || r.rowNumber < 2))
            throw new AppError('INVALID_INPUT', 'Некорректная пачка.');
        const parsed = validateRows(structuredClone(inputs)), hash = createHash('sha256').update(JSON.stringify(parsed.rows.map(r => [r.rowNumber, r.domain, r.about ?? '', r.referenceId ?? '', r.logo ?? '', r.logoAssetId ?? '']))).digest('hex');
        const batchId = this.db.transaction(() => {
            const old = this.db.sql.prepare('select id,hash from batches where owner_id=? and request_key=?').get(actor.userId, requestKey);
            if (old) {
                if (old.hash !== hash)
                    throw new AppError('CONFLICT', 'Ключ запроса связан с другой пачкой.');
                return String(old.id);
            }
            const id = randomUUID(), invalid = new Set(parsed.issues.map(i => i.rowNumber)).size;
            const d: LocalDraft = { summary: { id, name: 'Импорт', revision: 1, state: 'active', total: inputs.length, validCount: inputs.length - invalid, invalidCount: invalid, canControl: true }, assignedUserIds: [], hash };
            this.db.sql.prepare('insert into batches values(?,?,?,?,?,?)').run(id, actor.userId, requestKey, hash, 'active', JSON.stringify(d));
            return id;
        });
        // Bounded row transactions keep the event loop available for worker heartbeats.
        for (const input of parsed.rows) {
            this.db.transaction(() => {
                if (!this.db.sql.prepare('select row_number from batch_rows where batch_id=? and row_number=?').get(batchId, input.rowNumber))
                    this.putRow(batchId, { rowNumber: input.rowNumber, input, issues: parsed.issues.filter(i => i.rowNumber === input.rowNumber), siteId: null, job: null });
            });
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        await this.admit(actor, batchId);
        return { batchId, siteIds: this.rows(batchId).flatMap(r => r.siteId ? [r.siteId] : []) };
    }
    async admit(actor: Principal, id: string, maximum = 5000) {
        const pending = this.db.sql.prepare("select data from batch_rows where batch_id=? and site_id is null and json_array_length(json_extract(data,'$.issues'))=0 order by row_number limit ?").all(id, maximum).map(r => JSON.parse(String(r.data)) as ImportRowView);
        for (const row of pending) {
            const proceed = this.db.transaction(() => {
                const d = this.read(actor, id, true);
                if (d.summary.state !== 'active')
                    return false;
                const r = JSON.parse(String(this.db.sql.prepare('select data from batch_rows where batch_id=? and row_number=?').get(id, row.rowNumber)!.data)) as ImportRowView;
                if (r.siteId || r.issues.length)
                    return true;
                if (this.db.sql.prepare('select id from sites where domain=?').get(r.input.domain))
                    r.issues = [{ rowNumber: r.rowNumber, column: 'domain', code: 'DUPLICATE_DOMAIN', message: 'Домен уже есть в реестре.' }];
                else {
                    const siteId = randomUUID();
                    const input = parseSiteInput({ domain: r.input.domain, ...(r.input.about ? { about: r.input.about } : {}), ...(r.input.referenceId ? { referenceId: r.input.referenceId } : {}), ...(r.input.logoAssetId ? { logoAssetId: r.input.logoAssetId } : {}) });
                    const ownerId = String(this.db.sql.prepare('select owner_id from batches where id=?').get(id)!.owner_id);
                    const site: Site = { id: siteId, domain: input.domain, ownerId, assignedUserIds: [], input, revision: 0, draftId: null, publishedId: null, generationStatus: 'queued', domainStatus: 'pending' };
                    insertLocalSite(this.db, site);
                    insertLocalJob(this.db, { id: siteId, siteId, kind: 'generate', stage: 'brief', state: 'queued', checkpointId: null, baseRevision: 0 }, id);
                    r.siteId = siteId;
                }
                this.putRow(id, r);
                return true;
            });
            if (!proceed)
                break;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }
    async page(actor: Principal, id: string, cursor?: string, status = 'all') {
        this.read(actor, id);
        const n = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(n) || n < 0 || !['all', 'valid', 'invalid'].includes(status))
            throw new AppError('INVALID_INPUT', 'Некорректная страница.');
        const results = this.db.sql.prepare(`select r.data from batch_rows r where batch_id=? and row_number>? and (?='all' or (?='invalid' and (json_array_length(json_extract(r.data,'$.issues'))>0 or exists(select 1 from jobs j where j.id=r.site_id and j.state='needs_attention'))) or (?='valid' and json_array_length(json_extract(r.data,'$.issues'))=0 and not exists(select 1 from jobs j where j.id=r.site_id and j.state='needs_attention'))) order by row_number limit ?`).all(id, n, status, status, status, importLimits.pageRows + 1);
        const items = results.slice(0, importLimits.pageRows).map(r => JSON.parse(String(r.data)) as ImportRowView);
        for (const r of items)
            if (r.siteId) {
                const data = this.db.sql.prepare('select data from jobs where id=?').get(r.siteId);
                if (data) {
                    const j = JSON.parse(String(data.data)) as Job;
                    r.job = { id: j.id, stage: j.stage, state: j.state };
                }
            }
        return { items, nextCursor: results.length > importLimits.pageRows ? String(items.at(-1)!.rowNumber) : null };
    }
    async get(actor: Principal, id: string) { const d = this.read(actor, id); const count = Number(this.db.sql.prepare("select count(*) n from batch_rows r where batch_id=? and (json_array_length(json_extract(r.data,'$.issues'))>0 or exists(select 1 from jobs j where j.id=r.site_id and j.state='needs_attention'))").get(id)!.n); return { ...d.summary, invalidCount: count, validCount: d.summary.total - count, canControl: actor.role === 'admin' || this.db.sql.prepare('select owner_id from batches where id=?').get(id)!.owner_id === actor.userId }; }
    async pauseBatch(actor: Principal, id: string) {
        this.db.transaction(() => {
            const d = this.read(actor, id, true);
            if (d.summary.state !== 'active')
                throw new AppError('CONFLICT', 'Пачка не запущена.');
            d.summary.state = 'paused';
            this.save(d);
            this.db.sql.prepare("update jobs set pause=1 where batch_id=? and state not in ('completed','cancelled')").run(id);
        });
    }
    async resumeBatch(actor: Principal, id: string) {
        this.db.transaction(() => {
            const d = this.read(actor, id, true);
            if (d.summary.state !== 'paused')
                throw new AppError('CONFLICT', 'Пачка не приостановлена.');
            d.summary.state = 'active';
            this.save(d);
            for (const r of this.db.sql.prepare("select id,data from jobs where batch_id=? and state='paused'").all(id)) {
                const job = JSON.parse(String(r.data)) as Job;
                job.state = 'queued';
                this.db.sql.prepare("update jobs set state='queued',data=? where id=?").run(JSON.stringify(job), String(r.id));
            }
            this.db.sql.prepare('update jobs set pause=0 where batch_id=?').run(id);
        });
        await this.admit(actor, id, 25);
    }
    async cancelBatch(actor: Principal, id: string) {
        this.db.transaction(() => {
            const d = this.read(actor, id, true);
            d.summary.state = 'cancelled';
            this.save(d);
            for (const r of this.db.sql.prepare("select id,data from jobs where batch_id=? and state not in ('completed','cancelled')").all(id)) {
                const job = JSON.parse(String(r.data)) as Job;
                job.state = 'cancelled';
                this.db.sql.prepare("update jobs set data=?,state='cancelled',generation=generation+1,lease=null,pause=1 where id=?").run(JSON.stringify(job), String(r.id));
                this.db.sql.prepare('delete from operations where operation_id=?').run(String(r.id));
            }
        });
    }
}
