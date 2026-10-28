import { createHash, randomUUID } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existingLocalDatabase } from './local-database.js';
import { registerLocalPayload, assertLocalPayload } from './retention-schema.js';
import { AppError } from '../../contracts/src/model.js';
import type { ArtifactFile, ArtifactStore, Clock, IdSource, Manifest } from '../../contracts/src/model.js';
import { artifactLimits, checkArtifacts } from '../../core/src/artifacts.js';
import { missing, privateDirectory, readRegular, safeFile, writeExclusive } from './safe-files.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validId(id: string) { if (typeof id !== 'string' || !uuid.test(id))
    throw new AppError('INVALID_INPUT', 'Invalid manifest ID.'); return id; }
function hash(bytes: Uint8Array, algorithm: string) { return createHash(algorithm).update(bytes).digest('hex'); }
/** Immutable local artifact storage. A complete directory becomes visible in one rename. */
export async function createLocalArtifacts(directory: string, clock: Clock = { now: Date.now }, ids: IdSource = { next: randomUUID }): Promise<ArtifactStore> {
    const root = await privateDirectory(directory);
    await privateDirectory(join(root, 'manifests'));
    return {
        async put(siteId, files, templateVersion) {
            checkArtifacts(files);
            if (typeof siteId !== 'string' || !siteId.trim() || typeof templateVersion !== 'string' || !templateVersion.trim())
                throw new AppError('INVALID_INPUT', 'Site and template version are required.');
            const id = validId(ids.next());
            const createdAt = clock.now();
            if (!Number.isSafeInteger(createdAt))
                throw new AppError('INVALID_INPUT', 'Invalid clock.');
            // Snapshot before the first await: callers cannot mutate bytes during the commit.
            const snapshot = files.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes) }));
            const staging = join(root, '.staging-' + randomUUID());
            const final = join(root, 'manifests', id);
            await privateDirectory(staging);
            try {
                const entries: Manifest['files'] = [];
                for (const [index, file] of snapshot.entries()) {
                    const name = index + '.bin';
                    await writeExclusive(join(staging, name), file.bytes);
                    entries.push({ path: file.path, objectKey: 'manifests/' + id + '/' + name, size: file.bytes.byteLength, sha256: hash(file.bytes, 'sha256'), sha1: hash(file.bytes, 'sha1'), mediaType: file.mediaType });
                }
                const manifest: Manifest = { id, siteId, templateVersion, createdAt, files: entries };
                const db = await existingLocalDatabase(dirname(root)), payload = { kind: 'artifact' as const, id, siteId, objects: entries.map(f => ({ key: f.objectKey, size: f.size, sha256: f.sha256, mediaType: f.mediaType })), createdAt, protectUntil: createdAt + 600000, state: 'staging' as const, firstOrphanAt: null, claimToken: null };
                if (db)
                    db.transaction(() => registerLocalPayload(db.sql, payload));
                await writeExclusive(join(staging, 'manifest.json'), new TextEncoder().encode(JSON.stringify(manifest)));
                await privateDirectory(join(root, 'manifests'), false);
                try {
                    await lstat(final);
                    throw new AppError('CONFLICT', 'Manifest ID already exists.');
                }
                catch (error) {
                    if (!missing(error))
                        throw error;
                }
                await rename(staging, final);
                if (db)
                    db.transaction(() => registerLocalPayload(db.sql, { ...payload, state: 'available' }));
                return structuredClone(manifest);
            }
            finally {
                await rm(staging, { recursive: true, force: true });
            }
        },
        async read(manifestId) {
            validId(manifestId);
            const db = await existingLocalDatabase(dirname(root)), pin = randomUUID();
            if (db)
                db.transaction(() => { assertLocalPayload(db.sql, { kind: 'artifact', id: manifestId }); db.sql.prepare('insert into payload_pins values(?,?,?,?)').run(pin, 'artifact', manifestId, Date.now() + 600000); });
            try {
                const directory = await privateDirectory(join(root, 'manifests', manifestId), false);
                const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegular(await safeFile(directory, 'manifest.json'), 100000)));
                if (!raw || typeof raw !== 'object')
                    throw new AppError('INVALID_INPUT', 'Corrupt manifest.');
                const manifest = raw as Manifest;
                if (manifest.id !== manifestId || typeof manifest.siteId !== 'string' || !manifest.siteId.trim() ||
                    typeof manifest.templateVersion !== 'string' || !manifest.templateVersion.trim() || !Number.isSafeInteger(manifest.createdAt) ||
                    !Array.isArray(manifest.files) || manifest.files.length > artifactLimits.files)
                    throw new AppError('INVALID_INPUT', 'Corrupt manifest.');
                const files: ArtifactFile[] = [];
                for (const [index, entry] of manifest.files.entries()) {
                    if (!entry || typeof entry !== 'object' || entry.objectKey !== 'manifests/' + manifestId + '/' + index + '.bin' ||
                        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > artifactLimits.fileBytes ||
                        !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-f0-9]{40}$/.test(entry.sha1))
                        throw new AppError('INVALID_INPUT', 'Corrupt object metadata.');
                    const bytes = await readRegular(await safeFile(directory, index + '.bin'), artifactLimits.fileBytes);
                    if (bytes.byteLength !== entry.size || hash(bytes, 'sha256') !== entry.sha256 || hash(bytes, 'sha1') !== entry.sha1)
                        throw new AppError('INVALID_INPUT', 'Artifact checksum mismatch.');
                    files.push({ path: entry.path, mediaType: entry.mediaType, bytes });
                }
                checkArtifacts(files);
                const inventoried = db?.sql.prepare("select data from payload_inventory where kind='artifact' and id=?").get(manifestId);
                if (inventoried) {
                    const objects = JSON.parse(String(inventoried.data)).objects;
                    if (objects.length !== manifest.files.length || manifest.files.some((f, i) => objects[i].key !== f.objectKey || objects[i].size !== f.size || objects[i].sha256 !== f.sha256 || objects[i].mediaType !== f.mediaType))
                        throw new AppError('INVALID_INPUT', 'Artifact physical inventory mismatch.');
                }
                if (db && !db.sql.prepare("select 1 from payload_inventory where kind='artifact' and id=?").get(manifestId))
                    db.transaction(() => registerLocalPayload(db.sql, { kind: 'artifact', id: manifestId, siteId: manifest.siteId, objects: manifest.files.map(f => ({ key: f.objectKey, size: f.size, sha256: f.sha256, mediaType: f.mediaType })), createdAt: manifest.createdAt, protectUntil: Date.now() + 600000, state: 'available', firstOrphanAt: null, claimToken: null }));
                return files;
            }
            finally {
                if (db)
                    db.transaction(() => db.sql.prepare('delete from payload_pins where id=?').run(pin));
            }
        },
    };
}
