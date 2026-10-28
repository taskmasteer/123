import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseImport } from '../src/import/rows.js';
const csv = (text: string) => parseImport({ name: 'sites.csv', bytes: new TextEncoder().encode(text) });
function xlsx(cells: string, extra: Record<string, Uint8Array> = {}) {
    return { name: 'sites.xlsx', bytes: zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'), 'xl/workbook.xml': strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sites" sheetId="1" r:id="rId1"/></sheets></workbook>'), 'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + cells + '</sheetData></worksheet>'), ...extra }) };
}
const cell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
describe('bounded import parsing', () => {
    it('preserves BOM, quoted commas, embedded newlines and the exact about on one logical row', async () => {
        const result = await csv('\uFEFFdomain,about,logo\r\nEXAMPLE.COM,"One, two\nthree",brand.png\r\nsecond.test,,\r\n');
        expect(result.rows).toEqual([{ rowNumber: 2, domain: 'example.com', about: 'One, two\nthree', logo: 'brand.png' }, { rowNumber: 3, domain: 'second.test' }]);
        expect(result.issues).toContainEqual(expect.objectContaining({ rowNumber: 2, column: 'logo', code: 'LOGO_MAPPING_REQUIRED' }));
    });
    it('retains invalid rows and canonical IDN duplicates for correction', async () => {
        const r = await csv('domain,about\nпример.рф,First\nxn--e1afmkfd.xn--p1ai,Second\n,Missing\n');
        expect(r.rows).toHaveLength(3);
        expect(r.issues.map(i => [i.rowNumber, i.code])).toEqual([[3, 'DUPLICATE_DOMAIN'], [4, 'INVALID_DOMAIN']]);
    });
    it('retains an empty logical record between data rows with its own row number', async () => { const r = await csv('domain\na.test\n\nb.test\n'); expect(r.rows.map(v => v.rowNumber)).toEqual([2, 3, 4]); expect(r.issues).toContainEqual(expect.objectContaining({ rowNumber: 3, code: 'INVALID_DOMAIN' })); });
    it('rejects malformed quoting, source/cell/row overflow and unknown or duplicate headers without truncation', async () => {
        await expect(csv('domain,about\na.test,"unclosed')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(csv('domain,about\na.test,' + 'x'.repeat(8001))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(csv('domain\n' + Array.from({ length: 5001 }, (_, i) => `s${i}.test`).join('\n'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(csv('domain,domain\na.test,b.test')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
    it('reads empty XLSX cells and emits a formula issue instead of accepting a cached value', async () => {
        const r = await parseImport(xlsx(`<row r="1">${cell('A1', 'domain')}${cell('B1', 'about')}</row><row r="2">${cell('A2', 'a.test')}</row><row r="3">${cell('A3', 'b.test')}<c r="B3"><f>WEBSERVICE("https://bad.test")</f><v>123</v></c></row>`));
        expect(r.rows).toHaveLength(2);
        expect(r.rows[0]).toEqual({ rowNumber: 2, domain: 'a.test' });
        expect(r.issues).toContainEqual(expect.objectContaining({ rowNumber: 3, column: 'about', code: 'FORMULA_NOT_ALLOWED' }));
        expect(r.rows[1]?.about).toBeUndefined();
    });
    it('rejects macros, external relationships and oversized worksheet coordinates before the library allocates cells', async () => {
        await expect(parseImport(xlsx('', { 'xl/vbaProject.bin': new Uint8Array([1]) }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(parseImport(xlsx('<row r="999999"><c r="A999999"/></row>'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(parseImport(xlsx('', { 'xl/_rels/sheet.xml.rels': strToU8('<Relationships><Relationship TargetMode="External" Target="https://bad.test"/></Relationships>') }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
    it('never treats logo URLs or arbitrary asset IDs as authorized local mappings', async () => {
        const r = await csv('domain,logo\na.test,https://bad.test/logo.png\nb.test,../secret.png');
        expect(r.issues.every(i => i.code === 'INVALID_LOGO')).toBe(true);
        expect(r.issues).toHaveLength(2);
    });
    it('rejects tiny extreme dimensions, columns and overlong shared strings before OOXML parsing', async () => {
        const hugeDimension = { 'xl/worksheets/sheet1.xml': strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>domain</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>a.test</t></is></c></row></sheetData></worksheet>') };
        await expect(parseImport(xlsx('', hugeDimension))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(parseImport(xlsx('<row r="1"><c r="XFD1" t="inlineStr"><is><t>domain</t></is></c></row>'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(parseImport(xlsx('<row r="1">' + cell('A1', 'domain') + '</row><row r="2">' + cell('A2', 'a.test') + '</row>', { 'xl/sharedStrings.xml': strToU8('<sst><si><t>' + 'x'.repeat(8001) + '</t></si></sst>') }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
});
