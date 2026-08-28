import type { Readable } from "node:stream";
import { parse } from "csv-parse";
import { getTableColumns, sql } from "drizzle-orm";
import type { SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";

export type CsvRecord = Record<string, string>;
type DatabaseValue = string | number | null;
export type DatabaseRecord = Record<string, DatabaseValue>;
type UnparsedCsvRecord = Parameters<z.ZodType["parse"]>[0];

const csvRecordSchema = z.record(z.string(), z.string());

interface CsvRecordReader {
  read(): UnparsedCsvRecord | null;
}

interface DrainCsvRecordsOptions {
  reader: CsvRecordReader;
  transformRecord: (record: CsvRecord) => DatabaseRecord;
  shouldInclude?: (record: DatabaseRecord) => boolean;
  include(record: DatabaseRecord): void;
  skip(error?: Error): void;
}

/** Drain every currently readable record, advancing after rejects and skips. */
export function drainCsvRecords(options: DrainCsvRecordsOptions): void {
  let candidate = options.reader.read();
  while (candidate !== null) {
    try {
      const record = csvRecordSchema.parse(candidate);
      const transformed = options.transformRecord(record);
      if (!options.shouldInclude || options.shouldInclude(transformed)) {
        options.include(transformed);
      } else {
        options.skip();
      }
    } catch (error) {
      options.skip(
        error instanceof Error ? error : new Error("CSV record parsing failed"),
      );
    }
    candidate = options.reader.read();
  }
}

/** Read and drain a USDA CSV header before any import statement is prepared. */
export function readUsdaCsvFieldNames(input: Readable): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let fieldNames: string[] = [];
    const parser = parse({
      columns: (headers) => {
        fieldNames = z.array(z.string()).parse(headers);
        return headers;
      },
      to_line: 2,
    });
    parser.on("end", () => resolve(fieldNames));
    parser.on("error", reject);
    input.on("error", reject);
    input.pipe(parser);
    parser.resume();
  });
}

const duplicatesIn = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
};

/**
 * Validate that one USDA CSV is an exact column-for-column source for its
 * destination table, then construct the matching prepared-insert values.
 */
export function usdaInsertPlaceholders<TSchema extends SQLiteTable>(
  table: TSchema,
  csvFieldNames: readonly string[],
): SQLiteInsertValue<TSchema> {
  const tableFieldNames = Object.keys(getTableColumns(table));
  const csvFields = new Set(csvFieldNames);
  const tableFields = new Set(tableFieldNames);
  const duplicateFields = duplicatesIn(csvFieldNames);
  const missingFields = tableFieldNames.filter(
    (field) => !csvFields.has(field),
  );
  const unexpectedFields = csvFieldNames.filter(
    (field) => !tableFields.has(field),
  );

  if (
    duplicateFields.length > 0 ||
    missingFields.length > 0 ||
    unexpectedFields.length > 0
  ) {
    const details = [
      duplicateFields.length > 0
        ? `duplicate: ${duplicateFields.join(", ")}`
        : undefined,
      missingFields.length > 0
        ? `missing: ${missingFields.join(", ")}`
        : undefined,
      unexpectedFields.length > 0
        ? `unexpected: ${unexpectedFields.join(", ")}`
        : undefined,
    ].filter((detail) => detail !== undefined);
    throw new Error(
      `USDA CSV headers do not match table columns (${details.join("; ")})`,
    );
  }

  const values = Object.fromEntries(
    tableFieldNames.map((field) => [field, sql.placeholder(field)]),
  );
  // SAFETY: the exact-set validation above proves all and only TSchema's
  // columns are present; each value is Drizzle's typed SQL placeholder.
  return values as SQLiteInsertValue<TSchema>;
}
