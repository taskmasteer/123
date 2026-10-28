import { fromBuffer } from 'yauzl';
import { Parser } from 'saxen';
import { readSheet } from 'read-excel-file/node';
import { AppError } from '../../../contracts/src/model.js';
import { importLimits } from '../../../contracts/src/import.js';
const invalid = (): never => { throw new AppError('INVALID_INPUT', 'Небезопасный или слишком большой XLSX. Требуется один лист без макросов и внешних связей.'); };
/** Preflight the actual streamed expansion before handing bounded OOXML to the maintained reader. */
export async function xlsxRows(bytes: Uint8Array) {
    const formulas: {
        rowNumber: number;
        columnIndex: number;
    }[] = [];
    const names = new Set<string>();
    let expanded = 0, entries = 0, sheets = 0, cells = 0, strings = 0;
    const started = Date.now();
    await new Promise<void>((resolve, reject) => fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
        if (error || !zip) {
            reject(error);
            return;
        }
        const fail = (error: unknown) => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', resolve);
        zip.on('entry', entry => {
            void (async () => {
                const name = entry.fileName.toLowerCase();
                if (names.has(name))
                    invalid();
                names.add(name);
                if (++entries > importLimits.entries || entry.generalPurposeBitFlag & 1 || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 || entry.uncompressedSize > importLimits.expandedBytes || /^(?:\/|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)|\\/.test(entry.fileName) || /vbaProject|externalLinks|embeddings|activeX/i.test(entry.fileName))
                    invalid();
                if (entry.fileName.endsWith('/')) {
                    zip.readEntry();
                    return;
                }
                const stream = await new Promise<import('node:stream').Readable>((resolve, reject) => zip.openReadStream(entry, (e, s) => e || !s ? reject(e) : resolve(s)));
                const chunks: Buffer[] = [];
                for await (const chunk of stream) {
                    expanded += (chunk as Buffer).length;
                    if (expanded > importLimits.expandedBytes || Date.now() - started > 10000) {
                        stream.destroy();
                        invalid();
                    }
                    chunks.push(Buffer.from(chunk));
                }
                if (/\.(xml|rels)$/i.test(entry.fileName)) {
                    const xml = new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks));
                    let ref = '', inCell = false, inString = false, cellLength = 0, stringLength = 0;
                    const coordinates = new Set<string>(), formulaCoordinates = new Set<string>();
                    const parser = new Parser();
                    parser.on('error', invalid);
                    parser.on('warn', invalid);
                    parser.on('attention', invalid);
                    parser.on('openTag', (name, getAttrs) => {
                        const tag = name.split(':').at(-1), attrs = getAttrs();
                        if (/macroEnabled/i.test(Object.values(attrs).join(' ')) || Object.entries(attrs).some(([k, v]) => k.split(':').at(-1) === 'TargetMode' && v === 'External'))
                            invalid();
                        if (tag === 'sheet' && ++sheets > 1)
                            invalid();
                        if (tag === 'dimension') {
                            for (const point of (attrs.ref ?? '').split(':')) {
                                const m = /^([A-Z]+)([1-9][0-9]*)$/.exec(point);
                                if (!m)
                                    return invalid();
                                const col = [...m[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
                                if (col > importLimits.columns || Number(m[2]) > importLimits.rows + 1)
                                    invalid();
                            }
                        }
                        if (tag === 'row' && (!Number.isSafeInteger(Number(attrs.r)) || Number(attrs.r) < 1 || Number(attrs.r) > importLimits.rows + 1))
                            invalid();
                        if (tag === 'si') {
                            if (++strings > importLimits.rows * importLimits.columns)
                                invalid();
                            inString = true;
                            stringLength = 0;
                        }
                        if (tag === 'c') {
                            inCell = true;
                            cellLength = 0;
                            ref = attrs.r ?? '';
                            const m = /^([A-Z]+)([1-9][0-9]*)$/.exec(ref);
                            if (!m)
                                return invalid();
                            if (coordinates.has(ref))
                                invalid();
                            coordinates.add(ref);
                            const col = [...m[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
                            if (col > importLimits.columns || Number(m[2]) > importLimits.rows + 1 || ++cells > importLimits.rows * importLimits.columns + 16)
                                invalid();
                            if (attrs.t === 'e')
                                formulas.push({ rowNumber: Number(m[2]), columnIndex: col - 1 });
                        }
                        if (tag === 'f') {
                            const m = /^([A-Z]+)([0-9]+)$/.exec(ref);
                            if (!m || formulaCoordinates.has(ref) || formulas.length >= importLimits.rows * importLimits.columns)
                                return invalid();
                            formulaCoordinates.add(ref);
                            formulas.push({ rowNumber: Number(m[2]), columnIndex: [...m[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1 });
                        }
                    });
                    parser.on('closeTag', (name: unknown) => {
                        const tag = String(name).split(':').at(-1);
                        if (tag === 'c') {
                            inCell = false;
                            ref = '';
                        }
                        if (tag === 'si')
                            inString = false;
                    });
                    parser.on('text', (value: unknown) => {
                        const size = String(value).length;
                        if (inCell && (cellLength += size) > importLimits.cellCharacters)
                            invalid();
                        if (inString && (stringLength += size) > importLimits.cellCharacters)
                            invalid();
                        if (Date.now() - started > 10000)
                            invalid();
                    });
                    parser.parse(xml);
                }
                zip.readEntry();
            })().catch(fail);
        });
        zip.readEntry();
    }));
    const table = await readSheet(Buffer.from(bytes), 1, { trim: false });
    if (Date.now() - started > 10000)
        invalid();
    return { table, formulas };
}
