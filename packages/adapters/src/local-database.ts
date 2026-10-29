import { lstat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { AppError } from '../../contracts/src/model.js';
import type { Site, Job } from '../../contracts/src/model.js';
import { parseEditingState } from '../../contracts/src/editing.js';
import { parseState } from './local-state.js';
import { parseQueueState } from './local-queue.js';
import { parseRevision } from './local-revisions.js';
import { privateDirectory, safeFile, readRegular, missing } from './safe-files.js';
import { initializeRecovery } from './retention-schema.js';
import {isNativePersistencePermit,type NativePersistencePermit} from './native-persistence.js';
const controllers = new Set<string>();
const handles = new Map<string, LocalDatabase>();
const nativeHandles=new WeakSet<object>();
export function isNativeLocalDatabase(value:unknown):value is LocalDatabase{return !!value&&typeof value==='object'&&nativeHandles.has(value);}
export async function openNativeLocalDatabase(directory:string,permit:NativePersistencePermit):Promise<LocalDatabase>{if(!isNativePersistencePermit(permit))throw new AppError('FORBIDDEN','Verified private native bootstrap is required.');return openDatabase(directory,true);}
/** Only verified restore code with its actual source handle can carry this process-local scope. */
export async function openRestoredLocalDatabase(directory:string,source:LocalDatabase):Promise<LocalDatabase>{return openDatabase(directory,isNativeLocalDatabase(source));}
export async function existingLocalDatabase(directory: string) { const root = await privateDirectory(directory); return handles.get(process.platform === 'win32' ? root.toLowerCase() : root); }
export interface LocalDatabase {
    sql: DatabaseSync;
    root: string;
    transaction<T>(action: () => T): T;
    close(): Promise<void>;
    snapshot(destination: string): Promise<{
        database: string;
        immutableRoots: string[];
        mutableFiles: string[];
    }>;
}
export function insertLocalSite(db: LocalDatabase, site: Site) { db.sql.prepare('insert into sites(id,domain,owner_id,status,data) values(?,?,?,?,?)').run(site.id, site.domain, site.ownerId, site.generationStatus, JSON.stringify(site)); }
export function insertLocalJob(db: LocalDatabase, job: Job, batchId: string | null = null) {
    db.sql.prepare('insert into jobs(id,site_id,state,data,batch_id) values(?,?,?,?,?)').run(job.id, job.siteId, job.state, JSON.stringify(job), batchId);
    if (batchId)
        db.sql.prepare('insert into operations values(?,?,?)').run(job.siteId, job.id, 'job');
}
export async function openLocalDatabase(directory: string): Promise<LocalDatabase> {
    return openDatabase(directory,false);
}
async function openDatabase(directory:string,nativePrivate:boolean):Promise<LocalDatabase>{
    const version = process.versions.node.split('.'), major = Number(version[0]), minor = Number(version[1]);
    if (major < 24 || (major === 24 && minor < 21))
        throw new AppError('UNAVAILABLE', 'Node 24.21.0 or newer is required for normalized local storage.');
    if (process.env.NODE_ENV === 'production'&&!nativePrivate)
        throw new AppError('FORBIDDEN', 'Local storage is a demonstration adapter.');
    const root = await privateDirectory(directory), key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (controllers.has(key))
        throw new AppError('CONFLICT', 'Local controller is already open.');
    controllers.add(key);
    let sql: DatabaseSync | undefined;
    try {
        const path = await safeFile(root, 'factory.sqlite');
        const options = { allowExtension: false, timeout: 50, defensive: true };
        sql = new DatabaseSync(path, options);
        sql.exec(`pragma journal_mode=DELETE; pragma synchronous=FULL; pragma foreign_keys=ON; pragma locking_mode=EXCLUSIVE; begin exclusive; commit;
   create table if not exists metadata(key text primary key,value text not null) strict;
   create table if not exists sites(seq integer primary key autoincrement,id text unique not null,domain text unique not null,owner_id text not null,status text not null,data text not null) strict;
   create index if not exists sites_scope on sites(owner_id,seq);
   create table if not exists jobs(seq integer primary key autoincrement,id text unique not null,site_id text not null,state text not null,data text not null,lease text,generation integer not null default 0,batch_id text,pause integer not null default 0) strict;
   create index if not exists jobs_claim on jobs(state,pause,seq); create index if not exists jobs_site on jobs(site_id,seq);
   create table if not exists records(kind text not null,id text not null,site_id text not null,data text not null,primary key(kind,id)) strict;
   create index if not exists records_site on records(kind,site_id);
   create table if not exists batches(id text primary key,owner_id text not null,request_key text,hash text,state text not null,data text not null,unique(owner_id,request_key)) strict;
   create table if not exists batch_rows(batch_id text not null,row_number integer not null,data text not null,site_id text,primary key(batch_id,row_number)) strict;
   create table if not exists batch_assignments(batch_id text not null,user_id text not null,primary key(batch_id,user_id)) strict;
   create table if not exists operations(site_id text primary key,operation_id text not null,kind text not null) strict;
   create index if not exists batch_rows_site on batch_rows(site_id);
   create index if not exists batch_pending on batch_rows(batch_id,row_number) where site_id is null;
   create table if not exists chunks(resource_id text not null,part integer not null,bytes blob not null,primary key(resource_id,part)) strict;
   create table if not exists resources(id text primary key,owner_id text not null,data text not null) strict;`);
        initializeRecovery(sql);
        let closed = false, inTransaction = false;
        const db: LocalDatabase = { sql, root, transaction(action) {
                if (closed)
                    throw new AppError('CONFLICT', 'Local database is closed.');
                if (inTransaction)
                    throw new AppError('CONFLICT', 'Nested local transactions are forbidden.');
                sql!.exec('begin immediate');
                inTransaction = true;
                try {
                    const result = action();
                    if (result instanceof Promise)
                        throw new AppError('INVALID_INPUT', 'Local SQL transactions must be synchronous.');
                    sql!.exec('commit');
                    return result;
                }
                catch (error) {
                    sql!.exec('rollback');
                    throw error;
                }
                finally {
                    inTransaction = false;
                }
            }, async close() {
                if (closed)
                    return;
                closed = true;
                sql!.close();
                controllers.delete(key);
            }, async snapshot(destination) {
                const target = await privateDirectory(destination), file = await safeFile(target, 'factory.sqlite');
                db.transaction(() => {
                    if (sql!.prepare('pragma quick_check').get()?.quick_check !== 'ok')
                        throw new AppError('INVALID_INPUT', 'Local integrity check failed.');
                });
                sql!.prepare('vacuum into ?').run(file);
                return { database: file, immutableRoots: ['artifacts', 'checkpoints'], mutableFiles: ['catalog-overrides.json'] };
            } };
        const migrations: (() => void)[] = [];
        const sources = ['state.json', 'sites/state.json', 'queue.json', 'revisions.json', 'editing.json'];
        for (const source of sources) {
            let bytes: Uint8Array;
            try {
                const file = await safeFile(root, source), maximum = source.endsWith('state.json') ? 256 * 1024 * 1024 : 2000000, stat = await lstat(file);
                if (stat.size > maximum)
                    throw new AppError('INVALID_INPUT', 'Legacy source exceeds its bounded startup migration capacity; original preserved.');
                bytes = await readRegular(file, Math.min(maximum, stat.size));
            }
            catch (e) {
                if (missing(e))
                    continue;
                throw e;
            }
            const hash = createHash('sha256').update(bytes).digest('hex'), saved = sql.prepare('select value from metadata where key=?').get('migration:' + source)?.value;
            const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as unknown;
            const parsed = source.endsWith('state.json') ? parseState(value) : source === 'queue.json' ? parseQueueState(value) : source === 'editing.json' ? parseEditingState(value) : (() => {
                if (!Array.isArray(value))
                    throw new Error('Invalid revisions');
                const r = value.map(parseRevision);
                if (new Set(r.map(r => r.id)).size !== r.length || r.some(revision => revision.parentId !== null && !r.some(p => p.id === revision.parentId && p.siteId === revision.siteId)))
                    throw new Error('Invalid ancestry');
                return r;
            })();
            if (saved) {
                if (saved !== hash)
                    throw new AppError('INVALID_INPUT', 'Legacy source changed after migration; original preserved.');
                continue;
            }
            migrations.push(() => {
                if (source.endsWith('state.json'))
                    for (const s of (parsed as ReturnType<typeof parseState>).sites)
                        insertLocalSite(db, s);
                else if (source === 'queue.json')
                    for (const e of (parsed as ReturnType<typeof parseQueueState>).entries) {
                        insertLocalJob(db, e.job);
                        sql!.prepare('update jobs set lease=?,generation=? where id=?').run(e.lease ? JSON.stringify(e.lease) : null, e.generation, e.job.id);
                    }
                else if (source === 'editing.json') {
                    const state = parsed as ReturnType<typeof parseEditingState>;
                    for (const kind of ['candidates', 'messages', 'publications'] as const)
                        for (const r of state[kind])
                            sql!.prepare('insert into records values(?,?,?,?)').run(kind, r.id, r.siteId, JSON.stringify(r));
                }
                else
                    for (const r of parsed as ReturnType<typeof parseRevision>[])
                        sql!.prepare('insert into records values(?,?,?,?)').run('revisions', r.id, r.siteId, JSON.stringify(r));
                sql!.prepare('insert into metadata values(?,?)').run('migration:' + source, hash);
            });
        }
        db.transaction(() => {
            for (const migrate of migrations)
                migrate();
        });
        sql.close();
        sql = new DatabaseSync(path, options);
        db.sql = sql;
        initializeRecovery(sql);
        sql.exec('pragma locking_mode=EXCLUSIVE;begin exclusive;commit;');
        if (sql.prepare('pragma quick_check').get()?.quick_check !== 'ok')
            throw new Error('Integrity check failed');
        const savedSites = sql.prepare('select * from sites order by seq').all();
        parseState({ version: 1, savedAt: 0, sites: savedSites.map(r => JSON.parse(String(r.data))) });
        for (const row of savedSites) {
            const site = JSON.parse(String(row.data)) as Site;
            if (site.id !== row.id || site.domain !== row.domain || site.ownerId !== row.owner_id || site.generationStatus !== row.status)
                throw new Error('Indexed site fields do not match the record.');
        }
        const savedJobs = sql.prepare('select * from jobs order by seq').all();
        parseQueueState({ version: 1, entries: savedJobs.map(r => ({ job: JSON.parse(String(r.data)), generation: r.generation, lease: r.lease ? JSON.parse(String(r.lease)) : null })) });
        for (const row of savedJobs) {
            const job = JSON.parse(String(row.data)) as Job;
            if (job.id !== row.id || job.siteId !== row.site_id || job.state !== row.state)
                throw new Error('Indexed job fields do not match the record.');
        }
        const schema = sql.prepare('select value from metadata where key=?').get('schemaVersion');
        if (schema && schema.value !== '1')
            throw new Error('Unsupported local schema version.');
        if (!schema)
            sql.prepare('insert into metadata values(?,?)').run('schemaVersion', '1');
        handles.set(key, db);
        if(nativePrivate)nativeHandles.add(db);
        const close = db.close.bind(db);
        db.close = async () => {
            if (handles.get(key) === db)
                handles.delete(key);
            await close();
        };
        return db;
    }
    catch (error) {
        sql?.close();
        controllers.delete(key);
        if (error instanceof AppError)
            throw error;
        throw new AppError([5, 6].includes(Number((error as {
            errcode?: number;
        }).errcode)) ? 'CONFLICT' : 'INVALID_INPUT', 'Cannot open local database; original files were preserved.', { cause: error });
    }
}
