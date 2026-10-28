import { parse } from 'csv-parse';
import { AppError } from '../../../contracts/src/model.js';
import { importLimits } from '../../../contracts/src/import.js';
export async function csvRows(bytes: Uint8Array): Promise<unknown[][]> {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), rows: unknown[][] = [];
    const parser = parse(text, { bom: true, cast: false, relax_column_count: true, skip_empty_lines: false, max_record_size: importLimits.columns * importLimits.cellCharacters });
    for await (const row of parser) {
        if (rows.length > importLimits.rows)
            throw new AppError('INVALID_INPUT', 'В файле более 5000 строк.');
        rows.push(row as unknown[]);
    }
    return rows;
}
