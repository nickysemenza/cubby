/** Typed rows travel as one JSON parameter; defaults stay PostgreSQL's defaults. */
import { getTableColumns, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { RepositoryQueryClient } from "~/server/db/repository-access.boundary";

import { canonicalJson } from "./keys";
import { KernelContractError } from "./reads";
import type { ColumnValues } from "./row";

type Q = Pick<RepositoryQueryClient, "execute">;

/** Preserve physical column names and exact bigint values for PostgreSQL's row codec. */
export function physicalValues(
  table: PgTable,
  values: ColumnValues,
): ColumnValues {
  const columns = getTableColumns(table);
  return Object.fromEntries(
    Object.entries(values).flatMap(([property, value]) => {
      const column = columns[property];
      if (!column)
        throw new KernelContractError(`Unknown bulk-write column ${property}`);
      return value === undefined ? [] : [[column.name, value]];
    }),
  );
}

/** One statement for a table, regardless of rows or their optional column sets. */
export async function insertRows(
  q: Q,
  table: PgTable,
  rows: readonly ColumnValues[],
  suffix: SQL = sql``,
): Promise<void> {
  if (!rows.length) return;
  const columns = getTableColumns(table);
  const properties = [
    ...new Set(
      rows.flatMap((row) =>
        Object.keys(row).filter((key) => row[key] !== undefined),
      ),
    ),
  ];
  const filled = rows.map((row) =>
    Object.fromEntries(
      properties.flatMap((property) => {
        const column = columns[property];
        if (!column)
          throw new KernelContractError(
            `Unknown bulk-write column ${property}`,
          );
        const value =
          row[property] === undefined && column.defaultFn
            ? column.defaultFn()
            : row[property];
        return value === undefined ? [] : [[column.name, value]];
      }),
    ),
  );
  const projection = properties.map((property) => {
    const column = columns[property]!;
    const value = sql`decoded.${sql.identifier(column.name)}`;
    if (filled.every((row) => Object.hasOwn(row, column.name))) return value;
    const fallback =
      column.default === undefined ? sql`NULL` : sql`${column.default}`;
    return sql`CASE WHEN incoming.value ? ${column.name} THEN ${value} ELSE ${fallback} END`;
  });
  await q.execute(sql`
    INSERT INTO ${table} (${sql.join(
      properties.map((property) => sql.identifier(columns[property]!.name)),
      sql`, `,
    )})
    SELECT ${sql.join(projection, sql`, `)}
    FROM jsonb_array_elements(${canonicalJson(filled)}::jsonb) AS incoming(value)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table}, incoming.value) AS decoded
    ${suffix}`);
}
