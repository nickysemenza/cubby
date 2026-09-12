import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { presenceFilter } from "@cubby/schemas/pagination";
import {
  type AnyColumn,
  getTableColumns,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  arrayOverlapOrPresence,
  eqAny,
  eqAnyOrPresence,
  formatSearchTerm,
  presenceCondition,
  rangeConditions,
  textArrayMatches,
} from "./database-helpers";

const filterValues = z.record(z.string(), z.unknown());
const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const optionalDate = z.string().optional();
const optionalBoolean = z.boolean().optional();
const optionalTextList = z.array(z.string()).optional();

/** The descriptor facets this helper reads, independent of the literal roster. */
interface StoredDescriptorView {
  readonly columnId: string;
  readonly field: string | null;
  readonly kind: string;
  readonly stored: Readonly<{
    columns: readonly string[];
    array: boolean;
  }> | null;
  readonly nullable: Readonly<{ field: string }> | null;
  readonly range: Readonly<{ kind: "number" | "date" }> | null;
}

/** A stored column resolved to its table column and declared storage facts. */
interface StoredColumn {
  readonly column: AnyColumn;
  readonly kind: string;
  readonly nullable: boolean;
}

const descriptorsFor = (entity: Entity): readonly StoredDescriptorView[] =>
  Object.entries(entityInspectorMetadata).find(([key]) => key === entity)?.[1]
    .filterDescriptors ?? [];
const fieldModelFor = (entity: Entity) =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1];

const storedColumns = (
  entity: Entity,
  table: PgTable,
  descriptor: StoredDescriptorView,
): StoredColumn[] => {
  const storage = fieldModelFor(entity)?.storage ?? [];
  const columns: Record<string, AnyColumn> = getTableColumns(table);
  return (descriptor.stored?.columns ?? []).map((key) => {
    const stored = storage.find(({ key: k }) => k === key);
    const column =
      columns[key] ??
      Object.values(columns).find((c) => c.name === stored?.column);
    if (!column || !stored)
      throw new Error(
        `${entity}.${descriptor.columnId} has no table column ${key} for its stored filter`,
      );
    return { column, kind: stored.kind, nullable: stored.nullable };
  });
};

/** `formatSearchTerm` over every declared column, `text[]` columns by element. */
const textPredicate = (
  columns: readonly StoredColumn[],
  term: string | undefined,
): SQL | undefined =>
  or(
    ...columns.map(({ column, kind }) =>
      kind === "text-array"
        ? textArrayMatches(column, term)
        : formatSearchTerm(column, term),
    ),
  );

/**
 * A boolean filter over a boolean column is equality; over any other
 * (nullable) column it is presence: `true` is NOT NULL, `false` is NULL.
 */
const booleanPredicate = (
  { column, kind }: StoredColumn,
  flag: boolean | undefined,
): SQL | undefined =>
  kind === "boolean"
    ? eqAny(column, flag)
    : presenceCondition(
        column,
        flag === undefined ? undefined : flag ? "has" : "none",
      );

const dateRange = (
  column: AnyColumn,
  from: string | undefined,
  to: string | undefined,
): Array<SQL | undefined> => [
  from === undefined ? undefined : sql`${column} >= ${from}`,
  to === undefined ? undefined : sql`${column} <= ${to}`,
];

/**
 * The predicates a repository owes to descriptors declared `stored`: the
 * standard column predicate for each descriptor kind over the declared
 * stored columns. Text is a substring match ORed across its columns (a
 * `text[]` column matches by element), enum filters are equality or
 * membership with the declared nullable presence filter ORed in, a
 * multiselect declared `array` is an overlap with the same presence rule,
 * boolean is equality or presence, presence checks NULL, and ranges are
 * inclusive bounds. Anything richer (joins, OR groups across filters,
 * resolved ids) stays hand-written next to this spread in the repository's
 * where builder.
 */
export function declaredFilterPredicates<Filters extends object>(
  entity: Entity,
  table: PgTable,
  filters: Filters,
): Array<SQL | undefined> {
  const values = filterValues.parse(filters);
  return descriptorsFor(entity)
    .filter((descriptor) => descriptor.stored !== null)
    .flatMap((descriptor): Array<SQL | undefined> => {
      const key = descriptor.field ?? descriptor.columnId;
      const columns = storedColumns(entity, table, descriptor);
      const [first] = columns;
      if (first === undefined) return [];
      const value = values[key];
      const presence = descriptor.nullable
        ? presenceFilter.parse(values[descriptor.nullable.field])
        : undefined;
      switch (descriptor.kind) {
        case "text":
          return [textPredicate(columns, optionalText.parse(value)?.trim())];
        case "boolean":
          return [booleanPredicate(first, optionalBoolean.parse(value))];
        case "select":
        case "multiselect":
          return [
            descriptor.stored?.array
              ? arrayOverlapOrPresence(
                  first.column,
                  optionalTextList.parse(value),
                  presence,
                  first.nullable,
                )
              : descriptor.nullable
                ? eqAnyOrPresence(first.column, value, presence)
                : eqAny(first.column, value),
          ];
        case "presence":
          return [presenceCondition(first.column, presenceFilter.parse(value))];
        case "range":
          return descriptor.range?.kind === "date"
            ? dateRange(
                first.column,
                optionalDate.parse(values[`${key}From`]),
                optionalDate.parse(values[`${key}To`]),
              )
            : rangeConditions(
                first.column,
                {
                  [`${key}Min`]: optionalNumber.parse(values[`${key}Min`]),
                  [`${key}Max`]: optionalNumber.parse(values[`${key}Max`]),
                },
                key,
              );
        default:
          throw new Error(
            `${entity}.${descriptor.columnId} cannot derive a ${descriptor.kind} predicate`,
          );
      }
    });
}
