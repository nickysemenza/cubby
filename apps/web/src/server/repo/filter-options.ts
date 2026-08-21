import type {
  FilterOptionsInput,
  FilterOptionsOut,
} from "@cubby/schemas/filter-options";
import {
  type AnyColumn,
  and,
  asc,
  eq,
  exists,
  ilike,
  inArray,
  type SQL,
} from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  project,
  task,
  vendor,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";
import { loadLocationAncestors } from "~/server/repo/location/tree";

type OptionRow = {
  id: string;
  label: string;
  detail?: string;
  internalLocationId?: string;
};

const searchCondition = (column: AnyColumn, search: string) =>
  search === "" ? undefined : ilike(column, `%${search}%`);

/**
 * Minimal option rows for high-cardinality list filters. This deliberately
 * bypasses entity mappers: a dropdown never needs images, relation hydration,
 * pricing, counts, or data-quality enrichment.
 */
async function loadRows(
  db: Database,
  input: FilterOptionsInput,
  selectedOnly: boolean,
): Promise<OptionRow[]> {
  const dbClient = getDb(db);
  const offset = selectedOnly ? 0 : Number(input.cursor ?? "0");
  const limit = selectedOnly ? undefined : input.limit + 1;
  const selected = selectedOnly ? input.selectedIds : [];
  const whereSelected = (column: AnyColumn): SQL | undefined =>
    selected.length > 0 ? inArray(column, selected) : undefined;

  switch (input.kind) {
    case "product":
      return dbClient
        .select({
          id: product.shortcode,
          label: product.name,
          detail: product.manufacturer,
        })
        .from(product)
        .where(
          and(
            notDeleted(product),
            selectedOnly
              ? whereSelected(product.shortcode)
              : searchCondition(product.name, input.search),
          ),
        )
        .orderBy(asc(product.name), asc(product.shortcode))
        .limit(limit ?? 50)
        .offset(offset);

    case "task":
      return dbClient
        .select({ id: task.shortcode, label: task.name })
        .from(task)
        .where(
          and(
            notDeleted(task),
            selectedOnly
              ? whereSelected(task.shortcode)
              : searchCondition(task.name, input.search),
          ),
        )
        .orderBy(asc(task.name), asc(task.shortcode))
        .limit(limit ?? 50)
        .offset(offset);

    case "project":
      return dbClient
        .select({ id: project.shortcode, label: project.name })
        .from(project)
        .where(
          and(
            notDeleted(project),
            selectedOnly
              ? whereSelected(project.shortcode)
              : searchCondition(project.name, input.search),
          ),
        )
        .orderBy(asc(project.name), asc(project.shortcode))
        .limit(limit ?? 50)
        .offset(offset);

    case "vendor":
      return dbClient
        .select({ id: vendor.shortcode, label: vendor.name })
        .from(vendor)
        .where(
          and(
            notDeleted(vendor),
            selectedOnly
              ? whereSelected(vendor.shortcode)
              : searchCondition(vendor.name, input.search),
          ),
        )
        .orderBy(asc(vendor.name), asc(vendor.shortcode))
        .limit(limit ?? 50)
        .offset(offset);

    case "ingredientWithProduct":
      return dbClient
        .select({ id: ingredient.shortcode, label: ingredient.name })
        .from(ingredient)
        .where(
          and(
            notDeleted(ingredient),
            exists(
              dbClient
                .select({ id: product.id })
                .from(product)
                .where(
                  and(
                    eq(product.ingredientId, ingredient.id),
                    notDeleted(product),
                  ),
                ),
            ),
            selectedOnly
              ? whereSelected(ingredient.shortcode)
              : searchCondition(ingredient.name, input.search),
          ),
        )
        .orderBy(asc(ingredient.name), asc(ingredient.shortcode))
        .limit(limit ?? 50)
        .offset(offset);

    case "locationIdentityProduct":
      return dbClient
        .selectDistinct({ id: product.shortcode, label: product.name })
        .from(location)
        .innerJoin(
          product,
          and(eq(product.id, location.productId), notDeleted(product)),
        )
        .where(
          and(
            notDeleted(location),
            selectedOnly
              ? whereSelected(product.shortcode)
              : searchCondition(product.name, input.search),
          ),
        )
        .orderBy(asc(product.name), asc(product.shortcode))
        .limit(limit ?? 50)
        .offset(offset);

    case "locationWithInventory": {
      const rows = await dbClient
        .selectDistinct({
          id: location.shortcode,
          label: location.name,
          internalLocationId: location.id,
        })
        .from(location)
        .innerJoin(
          inventoryEntry,
          and(
            eq(inventoryEntry.locationId, location.id),
            notDeleted(inventoryEntry),
            stockOnly(),
          ),
        )
        .innerJoin(
          product,
          and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
        )
        .where(
          and(
            notDeleted(location),
            selectedOnly
              ? whereSelected(location.shortcode)
              : searchCondition(location.name, input.search),
          ),
        )
        .orderBy(asc(location.name), asc(location.shortcode))
        .limit(limit ?? 50)
        .offset(offset);
      const ancestors = await loadLocationAncestors(
        db,
        rows.map((row) => row.internalLocationId),
      );
      return rows.map((row) => ({
        ...row,
        detail:
          ancestors
            .get(row.internalLocationId)
            ?.map((ancestor) => ancestor.name)
            .join(" › ") || undefined,
      }));
    }
  }
}

export async function getFilterOptions(
  db: Database,
  input: FilterOptionsInput,
): Promise<FilterOptionsOut> {
  const [pageRows, selectedRows] = await Promise.all([
    loadRows(db, input, false),
    input.selectedIds.length > 0 ? loadRows(db, input, true) : [],
  ]);
  const hasNextPage = pageRows.length > input.limit;
  const page = pageRows.slice(0, input.limit);
  const byId = new Map(page.map((row) => [row.id, row]));
  for (const row of selectedRows) byId.set(row.id, row);

  return {
    items: [...byId.values()].map(({ id, label, detail }) => ({
      id,
      label,
      ...(detail ? { detail } : {}),
    })),
    nextCursor: hasNextPage
      ? String(Number(input.cursor ?? "0") + input.limit)
      : null,
  };
}
