import {
  listChildCountSchema,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { z } from "zod";

import type { Database } from "~/server/db";

import type { ListReadIntent } from "./database-helpers";
import type {
  ListProjection,
  ListReadPage,
  ListReadRow,
} from "./list-projection";

const childCountRowSchema = z.object({ childCount: listChildCountSchema });
/**
 * A tree scope's `childCount` is a list-row fact the entity's output schema
 * does not declare, so parsing a row strips it; carry it from each source row
 * onto its parsed row.
 */
export const withChildCounts = <Row>(
  parsed: readonly Row[],
  source: readonly unknown[],
): Row[] =>
  parsed.map((row, index) => {
    const { childCount } = childCountRowSchema.parse(source[index] ?? {});
    return childCount === undefined
      ? row
      : Object.assign({}, row, { childCount });
  });

/** Complete readers validate canonical rows while preserving count, totals, and grouping metadata. */
export async function parseCompleteListRead<
  S extends z.ZodType,
  Page extends ListReadPage<ListReadRow>,
>(
  schema: S,
  read: Promise<Page>,
): Promise<Omit<Page, "data"> & ListReadPage<z.output<S>>> {
  const { data, ...page } = await read;
  return {
    ...page,
    data: withChildCounts(
      data.map((row): z.output<S> => schema.parse(row)),
      data,
    ),
  };
}

export function completeListReader<
  S extends z.ZodType,
  Filters,
  Page extends ListReadPage<ListReadRow>,
  Context = never,
>(
  schema: S,
  read: (
    db: Database,
    filters: Filters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
    readIntent?: ListReadIntent,
    context?: Context,
  ) => Promise<Page>,
  summary?: (db: Database, filters: Filters) => Promise<Record<string, number>>,
) {
  return async (
    db: Database,
    filters: Filters,
    sorts: SortParams[],
    pagination: PaginationParams,
    readIntent: ListReadIntent = "page",
    context?: Context,
  ) => {
    const [page, sums] = await Promise.all([
      parseCompleteListRead(
        schema,
        read(
          db,
          filters,
          sorts,
          pagination,
          { kind: "full" },
          readIntent,
          context,
        ),
      ),
      summary?.(db, filters),
    ]);
    return sums ? { ...page, sums } : page;
  };
}
