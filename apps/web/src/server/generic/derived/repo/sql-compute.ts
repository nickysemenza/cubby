/**
 * The SQL compute adapter: evaluate a declared value's existing scalar SQL for
 * a batch of live rows, set-based in one statement. The expression is the one
 * the list used to evaluate per page, so the stored figure matches it exactly.
 */
import { and, inArray, isNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import { unwrapDb } from "~/server/db/helpers";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

const scalar = z.union([z.number(), z.string(), z.boolean(), z.null()]);

/**
 * `expression` renders the value for the current row of `table`; cast numeric
 * results to `double precision` so they decode as numbers. Soft-deleted rows
 * are absent, so their stored values are removed.
 */
export function sqlColumnCompute(
  source: { table: PgTable; id: PgColumn; deletedAt: PgColumn },
  expression: SQL,
): DerivedCompute {
  return async (db, ids) => {
    const rows = await unwrapDb(db)
      .select({ id: source.id, value: expression })
      .from(source.table)
      .where(and(inArray(source.id, [...ids]), isNull(source.deletedAt)));
    const out = new Map<string, DerivedComputed>();
    for (const row of rows) {
      const value = scalar.parse(row.value ?? null);
      out.set(String(row.id), {
        value,
        sort: typeof value === "boolean" ? Number(value) : value,
      });
    }
    return out;
  };
}
