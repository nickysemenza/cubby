import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { presenceFilter } from "@cubby/schemas/pagination";
import { type AnyColumn, getTableColumns, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  eqAny,
  eqAnyOrPresence,
  formatSearchTerm,
  presenceCondition,
  rangeConditions,
} from "./database-helpers";

const filterValues = z.record(z.string(), z.unknown());
const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const optionalDate = z.string().optional();

/** The descriptor facets this helper reads, independent of the literal roster. */
interface StoredDescriptorView {
  readonly columnId: string;
  readonly field: string | null;
  readonly kind: string;
  readonly stored: boolean;
  readonly nullable: Readonly<{ field: string }> | null;
  readonly range: Readonly<{ kind: "number" | "date" }> | null;
}

const descriptorsFor = (entity: Entity): readonly StoredDescriptorView[] =>
  Object.entries(entityInspectorMetadata).find(([key]) => key === entity)?.[1]
    .filterDescriptors ?? [];
const fieldModelFor = (entity: Entity) =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1];

/**
 * The predicates a repository owes to descriptors declared `stored: true`:
 * the standard column predicate for each descriptor kind over the model
 * field named by `columnId`. Text is a substring match, enum and boolean
 * filters are equality or membership (with the declared nullable presence
 * filter ORed in), presence checks NULL, and ranges are inclusive bounds.
 * Anything richer (joins, OR groups, resolved ids) stays hand-written next to
 * this spread in the repository's where builder.
 */
export function declaredFilterPredicates<Filters extends object>(
  entity: Entity,
  table: PgTable,
  filters: Filters,
): Array<SQL | undefined> {
  const descriptors = descriptorsFor(entity);
  const storage = fieldModelFor(entity)?.storage ?? [];
  const columns: Record<string, AnyColumn> = getTableColumns(table);
  const values = filterValues.parse(filters);
  return descriptors
    .filter((descriptor) => descriptor.stored)
    .flatMap((descriptor): Array<SQL | undefined> => {
      const key = descriptor.field ?? descriptor.columnId;
      const stored = storage.find(({ key: k }) => k === descriptor.columnId);
      const column =
        columns[descriptor.columnId] ??
        Object.values(columns).find((c) => c.name === stored?.column);
      if (!column)
        throw new Error(
          `${entity}.${descriptor.columnId} has no table column for its stored filter`,
        );
      const value = values[key];
      switch (descriptor.kind) {
        case "text":
          return [formatSearchTerm(column, optionalText.parse(value))];
        case "boolean":
          return [eqAny(column, value)];
        case "select":
        case "multiselect":
          return [
            descriptor.nullable
              ? eqAnyOrPresence(
                  column,
                  value,
                  presenceFilter.parse(values[descriptor.nullable.field]),
                )
              : eqAny(column, value),
          ];
        case "presence":
          return [presenceCondition(column, presenceFilter.parse(value))];
        case "range": {
          if (descriptor.range?.kind === "date") {
            const from = optionalDate.parse(values[`${key}From`]);
            const to = optionalDate.parse(values[`${key}To`]);
            return [
              from === undefined ? undefined : sql`${column} >= ${from}`,
              to === undefined ? undefined : sql`${column} <= ${to}`,
            ];
          }
          return rangeConditions(
            column,
            {
              [`${key}Min`]: optionalNumber.parse(values[`${key}Min`]),
              [`${key}Max`]: optionalNumber.parse(values[`${key}Max`]),
            },
            key,
          );
        }
        default:
          throw new Error(
            `${entity}.${descriptor.columnId} cannot derive a ${descriptor.kind} predicate`,
          );
      }
    });
}
