import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
/** Exercise the same fixed installed-catalog inventory the native backup assembler contributes. */
export async function appendInstalledCatalog(records: any[], payloads: Map<number, Uint8Array>, wrapped = false) { const styles = JSON.parse(await readFile('templates/catalog.json', 'utf8')), paths = ['templates/catalog.json', 'references/catalog.json', ...styles.flatMap((s: any) => s.files.map((p: string) => 'templates/' + s.id + '/' + p))]; const current = { type: 'row', table: 'private.recovery_state', row: { key: 'installed-catalog', data: { versions: styles.map((s: any) => s.id + '@' + s.version) } } }; records.push(wrapped ? { seq: records.length, data: current } : current); for (const path of paths) {
    const seq = records.length, bytes = await readFile(path), data = { type: 'file', root: 'catalog', path, payload: 'payloads/' + (100000 + seq) + '.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/octet-stream' };
    records.push(wrapped ? { seq, data } : data);
    payloads.set(seq, bytes);
} }
