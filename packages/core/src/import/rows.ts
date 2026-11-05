import { AppError } from '../../../contracts/src/model.js';
import { importLimits } from '../../../contracts/src/import.js';
import type { ImportResult, ImportRow, RowIssue } from '../../../contracts/src/import.js';
import { normalizeDomain } from '../sites.js';
import { mentionedUrl } from '../../../contracts/src/domain-policy.js';
import { csvRows } from './csv.js';
import { xlsxRows } from './xlsx.js';
export function validateRows(rows: ImportRow[], previous: RowIssue[] = []): ImportResult {
    const issues = previous.filter(i => !['INVALID_DOMAIN', 'DUPLICATE_DOMAIN', 'LOGO_MAPPING_REQUIRED', 'INVALID_LOGO', 'INVALID_ABOUT', 'INVALID_REFERENCE', 'INVALID_LINK', 'INVALID_LINK_DESCRIPTION'].includes(i.code));
    const seen = new Set<string>();
    for (const row of rows) {
        const issue = (column: string, code: string, message: string) => issues.push({ rowNumber: row.rowNumber, column, code, message });
        if(!row.mentionedUrl?.trim())issue('mentionedUrl','INVALID_LINK','Упоминаемая ссылка обязательна.');
        if(row.mentionedUrl){try{mentionedUrl(row.mentionedUrl);}catch{issue('mentionedUrl','INVALID_LINK','Укажите разрешённую публичную HTTP(S)-ссылку.');}}
        if(row.mentionedDescription!==undefined&&row.mentionedDescription.length>8000)issue('mentionedDescription','INVALID_LINK_DESCRIPTION','Пояснение: не более 8000 символов.');
        if (row.about !== undefined && (typeof row.about !== 'string' || row.about.length > 8000))
            issue('about', 'INVALID_ABOUT', 'Описание должно содержать не более 8000 символов.');
        if (row.layoutReferenceId !== undefined && (typeof row.layoutReferenceId !== 'string' || row.layoutReferenceId.length > 100))issue('layoutReferenceId','INVALID_REFERENCE','Некорректный референс.');
        if (row.referenceId !== undefined && (typeof row.referenceId !== 'string' || row.referenceId.length > 100))
            issue('referenceId', 'INVALID_REFERENCE', 'Идентификатор референса: не более 100 символов.');
        try {
            row.domain = normalizeDomain(row.domain);
            if (seen.has(row.domain))
                issue('domain', 'DUPLICATE_DOMAIN', 'Домен повторяется в файле.');
            seen.add(row.domain);
        }
        catch {
            issue('domain', 'INVALID_DOMAIN', 'Укажите корректный домен.');
        }
        if (row.logo && !row.logoAssetId) {
            if (/[:/\\\x00-\x1f]/.test(row.logo) || row.logo === '..' || row.logo.length > 200)
                issue('logo', 'INVALID_LOGO', 'Выберите локальный файл по имени без пути или URL.');
            else
                issue('logo', 'LOGO_MAPPING_REQUIRED', 'Сопоставьте выбранный локальный файл логотипа.');
        }
    }
    return { rows, issues };
}
export function tableRows(table: unknown[][], formulaCells: {
    rowNumber: number;
    columnIndex: number;
}[] = []): ImportResult {
    if (table.length < 1 || table.length > importLimits.rows + 1)
        throw new AppError('INVALID_INPUT', 'Допускается заголовок и не более 5000 строк.');
    const aliases: Record<string, string> = { domain: 'domain', 'домен': 'domain', about: 'about', 'о сайте': 'about', referenceid: 'referenceId', layoutreferenceid:'layoutReferenceId', logo: 'logo', 'логотип': 'logo', mentionedurl:'mentionedUrl', 'упоминаемая ссылка':'mentionedUrl', mentioneddescription:'mentionedDescription', 'пояснение ссылки':'mentionedDescription' };
    const headers = table[0]!.map(v => aliases[String(v ?? '').trim().toLowerCase()]);
    if (!headers.includes('domain') || headers.some(v => !v) || new Set(headers).size !== headers.length || headers.length > importLimits.columns)
        throw new AppError('INVALID_INPUT', 'Заголовки: domain, about, referenceId, logo, mentionedUrl, mentionedDescription; без повторов.');
    const rows: ImportRow[] = [], issues: RowIssue[] = [];
    const formulasByRow = new Map<number, Set<number>>();
    for (const formula of formulaCells) {
        let columns = formulasByRow.get(formula.rowNumber);
        if (!columns) {
            columns = new Set();
            formulasByRow.set(formula.rowNumber, columns);
        }
        columns.add(formula.columnIndex);
    }
    for (let index = 1; index < table.length; index++) {
        const cells = table[index]!;
        if (cells.length > headers.length || cells.some(c => String(c ?? '').length > importLimits.cellCharacters))
            throw new AppError('INVALID_INPUT', 'Превышен размер ячейки или число столбцов.');
        const row: ImportRow = { rowNumber: index + 1, domain: '' };
        const formulas = formulasByRow.get(index + 1);
        cells.forEach((value, column) => {
            if (formulas?.has(column))
                return;
            if (value !== null && value !== undefined && String(value) !== '')
                Object.assign(row, { [headers[column]!]: String(value) });
        });
        for (const column of formulas ?? [])
            issues.push({ rowNumber: index + 1, column: headers[column] ?? String(column + 1), code: 'FORMULA_NOT_ALLOWED', message: 'Замените формулу обычным значением.' });
        rows.push(row);
    }
    return validateRows(rows, issues);
}
export async function parseImport(file: {
    name: string;
    bytes: Uint8Array;
}): Promise<ImportResult> {
    if (file.bytes.byteLength > importLimits.sourceBytes || !file.bytes.byteLength)
        throw new AppError('INVALID_INPUT', 'Размер файла: от 1 байта до 16 МБ.');
    try {
        if (/\.csv$/i.test(file.name))
            return tableRows(await csvRows(file.bytes));
        if (/\.xlsx$/i.test(file.name)) {
            const { table, formulas } = await xlsxRows(file.bytes);
            return tableRows(table, formulas);
        }
    }
    catch (error) {
        if (error instanceof AppError)
            throw error;
        throw new AppError('INVALID_INPUT', 'Не удалось прочитать файл CSV/XLSX.', { cause: error });
    }
    throw new AppError('INVALID_INPUT', 'Выберите CSV или XLSX.');
}
