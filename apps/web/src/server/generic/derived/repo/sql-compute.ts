import {
  fieldProvenance,
  fieldEmptyReason,
} from "@cubby/schemas/field-envelope";
/**
 * The SQL compute adapter: evaluate a declared value's existing scalar SQL for
 * a batch of live rows, set-based in one statement. The expression is the one
 * the list used to evaluate per page, so the stored figure matches it exactly.
 */
import { and, inArray, isNull, sql, SQL } from "drizzle-orm";
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
  options: {
    provenance?: SQL;
    emptyReason?: z.output<typeof fieldEmptyReason> | SQL;
  } = {},
): DerivedCompute {
  return async (db, ids) => {
    const rows = await unwrapDb(db)
      .select({
        id: source.id,
        value: expression,
        emptyReason:
          options.emptyReason instanceof SQL
            ? options.emptyReason
            : sql`${options.emptyReason ?? "unset"}`,
        provenance:
          options.provenance ??
          sql`${JSON.stringify(fieldProvenance.parse({ kind: "computed" }))}::jsonb`,
      })
      .from(source.table)
      .where(and(inArray(source.id, [...ids]), isNull(source.deletedAt)));
    const out = new Map<string, DerivedComputed>();
    for (const row of rows) {
      const value = scalar.parse(row.value ?? null);
      out.set(String(row.id), {
        value,
        sort: typeof value === "boolean" ? Number(value) : value,
        decision: {
          outcome:
            value === null
              ? {
                  kind: "empty",
                  reason: fieldEmptyReason.parse(row.emptyReason),
                }
              : { kind: "value" },
          provenance: fieldProvenance.parse(row.provenance),
        },
      });
    }
    return out;
  };
}
