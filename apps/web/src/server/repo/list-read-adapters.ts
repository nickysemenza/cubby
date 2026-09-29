import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { z } from "zod";

import type { Database } from "~/server/db";

import type { ListReadIntent } from "./database-helpers";
import type {
  ListProjection,
  ListReadPage,
  ListReadRow,
} from "./list-projection";

/** Complete readers validate canonical rows while preserving count, totals, and grouping metadata. */
export async function parseCompleteListRead<
  S extends z.ZodType,
  Page extends ListReadPage<ListReadRow>,
>(
  schema: S,
  read: Promise<Page>,
): Promise<Omit<Page, "data"> & ListReadPage<z.output<S>>> {
  const { data, ...page } = await read;
  return { ...page, data: data.map((row) => schema.parse(row)) };
}

export function completeListReader<
  S extends z.ZodType,
  Filters,
  Page extends ListReadPage<ListReadRow>,
>(
  schema: S,
  read: (
    db: Database,
    filters: Filters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
    readIntent?: ListReadIntent,
  ) => Promise<Page>,
  summary?: (db: Database, filters: Filters) => Promise<Record<string, number>>,
) {
  return async (
    db: Database,
    filters: Filters,
    sorts: SortParams[],
    pagination: PaginationParams,
    readIntent: ListReadIntent = "page",
  ) => {
    const [page, sums] = await Promise.all([
      parseCompleteListRead(
        schema,
        read(db, filters, sorts, pagination, { kind: "full" }, readIntent),
      ),
      summary?.(db, filters),
    ]);
    return sums ? { ...page, sums } : page;
  };
}
