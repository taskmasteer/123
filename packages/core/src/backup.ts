export interface BackupEntry {
    name: string;
    size: number;
    sha256: string;
    read(): Promise<Uint8Array>;
}
export interface RestoreEntry {
    name: string;
    size: number;
    sha256: string;
    file: string;
}
export interface RestoreEntries extends Iterable<RestoreEntry> {
    readonly length: number;
    at(index: number): RestoreEntry | undefined;
}
export interface PortableArchive {
    create(passphrase: string, entries: AsyncIterable<BackupEntry>): Promise<string>;
    verify(path: string, passphrase: string): Promise<{
        directory: string;
        entries: RestoreEntries;
    }>;
}
import type { Principal } from '../../contracts/src/model.js';
import type { ExportHandle, RestoreReport, SourceAccess } from '../../contracts/src/recovery.js';
import { createSourceFiles } from './history.js';
export interface BackupSnapshot {
    entries: AsyncIterable<BackupEntry>;
    release(): Promise<void>;
}
/** Adapter owns coherent capture, crypto and physical handles; this facade owns authority and lifetime. */
export async function createBackup<H = ExportHandle>(actor: Principal, passphrase: string, ports: {
    admin(actor: Principal): Promise<void>;
    snapshot(): Promise<BackupSnapshot>;
    archive: PortableArchive;
    handle(file: string): Promise<H>;
    discard(file: string): Promise<void>;
}): Promise<H> { await ports.admin(actor); const snapshot = await ports.snapshot(); let file: string | undefined; try {
    file = await ports.archive.create(passphrase, snapshot.entries);
    await ports.admin(actor);
    return await ports.handle(file);
}
catch (error) {
    if (file)
        await ports.discard(file);
    throw error;
}
finally {
    await snapshot.release();
} }
export async function restoreBackup<T>(actor: Principal, path: string, passphrase: string, target: T, ports: {
    admin(actor: Principal): Promise<void>;
    archive: PortableArchive;
    validate(verified: {
        directory: string;
        entries: RestoreEntries;
    }, target: T): Promise<void>;
    install(verified: {
        directory: string;
        entries: RestoreEntries;
    }, target: T): Promise<RestoreReport>;
    dispose(verified: {
        directory: string;
        entries: RestoreEntries;
    }): Promise<void>;
}): Promise<RestoreReport> { await ports.admin(actor); const verified = await ports.archive.verify(path, passphrase); try {
    await ports.validate(verified, target);
    await ports.admin(actor);
    return await ports.install(verified, target);
}
finally {
    await ports.dispose(verified);
} }
export async function exportSite<H = ExportHandle>(actor: Principal, siteId: string, revisionId: string, ports: {
    source: SourceAccess;
    write(files: import('../../contracts/src/model.js').ArtifactFile[]): Promise<string>;
    handle(file: string): Promise<H>;
    discard(file: string): Promise<void>;
}): Promise<H> { const files = await createSourceFiles(ports.source).files(actor, siteId, revisionId), file = await ports.write(files); try {
    await ports.source.admin(actor);
    return await ports.handle(file);
}
catch (error) {
    await ports.discard(file);
    throw error;
} }
