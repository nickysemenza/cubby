import fs from "node:fs";
import { parse } from "csv-parse";
import { z } from "zod";

const cells = z.array(z.string());

export type CsvRow<C extends string> = (column: C) => string;

/**
 * Stream one FDC CSV, yielding a reader over `columns` per row. Rows stay
 * arrays so a 27M-row food_nutrient.csv never pays for per-row header
 * objects; the header is checked once so a renamed USDA column fails before
 * any row is read.
 */
export async function* readCsv<const C extends string>(
  file: string,
  columns: readonly C[],
): AsyncGenerator<CsvRow<C>> {
  const parser = fs.createReadStream(file).pipe(
    parse({
      skip_empty_lines: true,
      trim: true,
      quote: '"',
      escape: '"',
    }),
  );
  let indexes: Map<C, number> | null = null;
  for await (const record of parser) {
    const row = cells.parse(record);
    if (indexes === null) {
      const header = row;
      indexes = new Map(
        columns.map((column) => {
          const index = header.indexOf(column);
          if (index < 0) throw new Error(`${file}: missing column ${column}`);
          return [column, index];
        }),
      );
      continue;
    }
    const columnIndexes = indexes;
    yield (column) => row[columnIndexes.get(column) ?? -1] ?? "";
  }
}

/** Empty CSV cells are absent values, as in the old importer. */
export const text = (value: string): string | null =>
  value === "" ? null : value;

export const number = (value: string): number | null => {
  if (value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export const integer = (value: string): number | null => {
  if (value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
};
