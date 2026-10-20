import { DERIVED_REFRESH_PAGE } from "@cubby/schemas/derived-refresh";
import type { Entity } from "@cubby/schemas/entity-core";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import { searchableEntities } from "@cubby/schemas/search";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  financialTransaction,
  gardenEntry,
  ingredient,
  inventoryEntry,
  location,
  planting,
  product,
  productCategory,
  project,
  purchase,
  task,
} from "~/server/db/schema";

type RefTable = PgTable & { id: AnyPgColumn; deletedAt: AnyPgColumn };
type Route = {
  entity: Entity;
  transitive?: boolean;
  select: (id: string) => SQL;
};
const direct = (
  entity: Entity,
  table: RefTable,
  column: AnyPgColumn,
  transitive = false,
): Route => ({
  entity,
  transitive,
  select: (id) => sql`SELECT ${table.id} AS id FROM ${table}
    WHERE ${column}=${id}::uuid AND ${notDeleted(table)}`,
});
const linked = (entity: Entity, kind: string, transitive = false): Route => ({
  entity,
  transitive,
  select: (id) => sql`SELECT DISTINCT l."fromEntityId" AS id FROM "EntityLink" l
    JOIN "Entity" e ON e.id=l."fromEntityId" AND e.kind=${entity} AND e."deletedAt" IS NULL
    WHERE l.kind=${kind} AND l."toEntityId"=${id}::uuid AND l."deletedAt" IS NULL`,
});

/** Direct frontiers, not recursive closures: the durable visited set owns BFS. */
const dependencies = {
  product: [
    linked("product", "productComponent", true),
    direct("inventory", inventoryEntry, inventoryEntry.productId),
    direct("task", task, task.subjectProductId, true),
    direct("expense", expense, expense.productId),
    linked("wish", "wishCandidate"),
    {
      entity: "purchase",
      select: (id) => sql`SELECT DISTINCT "purchaseId" AS id FROM "Expense"
        WHERE "productId"=${id}::uuid AND "purchaseId" IS NOT NULL AND "deletedAt" IS NULL`,
    },
    {
      entity: "ingredient",
      transitive: true,
      select: (id) =>
        sql`SELECT "ingredientId" AS id FROM "Product" WHERE id=${id}::uuid AND "ingredientId" IS NOT NULL`,
    },
  ],
  productCategory: [
    direct("productCategory", productCategory, productCategory.parentId, true),
    direct("product", product, product.categoryId, true),
  ],
  location: [
    direct("location", location, location.parentId, true),
    direct("inventory", inventoryEntry, inventoryEntry.locationId),
    direct("planting", planting, planting.locationId),
    direct("gardenEntry", gardenEntry, gardenEntry.locationId),
  ],
  ingredient: [
    direct("product", product, product.ingredientId, true),
    {
      entity: "recipe",
      transitive: true,
      select: (id) => sql`SELECT DISTINCT s."recipeId" AS id
    FROM "RecipeSectionIngredient" i JOIN "RecipeSection" s ON s.id=i."recipeSectionId" AND s."deletedAt" IS NULL
    WHERE i."ingredientId"=${id}::uuid AND i."deletedAt" IS NULL`,
    },
  ],
  recipe: [
    {
      entity: "meal",
      select: (id) =>
        sql`SELECT DISTINCT "mealId" AS id FROM "MealRecipe" WHERE "recipeId"=${id}::uuid AND "deletedAt" IS NULL`,
    },
    direct("ingredient", ingredient, ingredient.recipeId, true),
  ],
  task: [direct("task", task, task.parentTaskId, true)],
  project: [
    direct("project", project, project.parentProjectId, true),
    direct("task", task, task.projectId, true),
    direct("expense", expense, expense.projectId, true),
    direct("purchase", purchase, purchase.defaultProjectId, true),
    // The household fallback can affect any unassigned food line. Walking the
    // indexed Expense frontier also covers adjustment siblings without allocating
    // the whole ledger merely to find one background page.
    {
      entity: "expense",
      transitive: true,
      select: (id) => sql`SELECT e.id FROM "Expense" e
      WHERE e."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "Project" p
        WHERE p.id=${id}::uuid AND p.shortcode='PRJ-HSHD' AND p."deletedAt" IS NULL)`,
    },
  ],
  vendor: [direct("purchase", purchase, purchase.vendorId, true)],
  purchase: [
    direct("expense", expense, expense.purchaseId, true),
    {
      entity: "financialTransaction",
      select: (
        id,
      ) => sql`SELECT DISTINCT a."transactionId" AS id FROM "FinancialTransactionAllocation" a
      JOIN "FinancialTransaction" t ON t.id=a."transactionId" AND t."deletedAt" IS NULL
      WHERE a."purchaseId"=${id}::uuid AND a."deletedAt" IS NULL`,
    },
  ],
  financialAccount: [
    direct(
      "financialTransaction",
      financialTransaction,
      financialTransaction.accountId,
    ),
  ],
  expense: [
    // Adjustment project text is allocated from the purchase's principal lines.
    {
      entity: "expense",
      select: (id) => sql`SELECT adjustment.id FROM "Expense" principal
        JOIN "Expense" adjustment ON adjustment."purchaseId"=principal."purchaseId"
        WHERE principal.id=${id}::uuid
          AND adjustment."lineKind" NOT IN (${expenseLineKindSchema.enum.principal},${expenseLineKindSchema.enum.unclassified})
          AND adjustment."deletedAt" IS NULL`,
    },
    // Tombstoned rows retain the old price source for repair after removals.
    {
      entity: "product",
      transitive: true,
      select: (id) =>
        sql`SELECT "productId" AS id FROM "Expense" WHERE id=${id}::uuid AND "productId" IS NOT NULL`,
    },
    {
      entity: "purchase",
      select: (id) =>
        sql`SELECT "purchaseId" AS id FROM "Expense" WHERE id=${id}::uuid AND "purchaseId" IS NOT NULL`,
    },
  ],
  plant: [direct("planting", planting, planting.plantId, true)],
  planting: [linked("gardenEntry", "gardenEntryPlanting")],
} satisfies Partial<Record<Entity, readonly Route[]>>;

// Saved endpoints can own narrower frontiers than an edit to the endpoint
// itself. In particular, a moved/deleted principal cannot find old siblings
// through its current Expense row, and must not walk every Purchase line.
const endpointDependencies = {
  expense: {
    purchase: [
      {
        entity: "expense",
        select: (id) => sql`SELECT id FROM "Expense"
        WHERE "purchaseId"=${id}::uuid AND "deletedAt" IS NULL
        AND "lineKind" NOT IN (${expenseLineKindSchema.enum.principal},${expenseLineKindSchema.enum.unclassified})`,
      },
    ],
  },
} satisfies Partial<Record<Entity, Partial<Record<Entity, readonly Route[]>>>>;

export function refreshEndpointDependencyRoutes(
  root: Entity,
  endpoint: Entity,
): readonly Route[] | undefined {
  const routes = Object.entries(endpointDependencies).find(
    ([kind]) => kind === root,
  )?.[1];
  return routes
    ? Object.entries(routes).find(([kind]) => kind === endpoint)?.[1]
    : undefined;
}

export function refreshDependencyRoutes(entity: Entity): readonly Route[] {
  if (entity === "image")
    return searchableEntities.map((owner) => ({
      entity: owner,
      select: (
        id: string,
      ) => sql`SELECT DISTINCT a."entityId" AS id FROM "EntityAttachment" a
      WHERE a."imageId"=${id}::uuid AND a."entityKind"=${owner} AND a."deletedAt" IS NULL`,
    }));
  if (entity in dependencies) {
    // Access through a total declaration projection keeps missing entities empty.
    return (
      Object.entries(dependencies).find(([key]) => key === entity)?.[1] ?? []
    );
  }
  return [];
}

/** Cursor applies to each indexed frontier; no entire closure crosses the wire. */
export async function readRefreshDependencyPage(
  db: Database,
  route: Route,
  sourceId: string,
  after: string | null,
) {
  const rows = await getDb(db).execute<{ id: string }>(sql`
    SELECT DISTINCT r.id FROM (${route.select(sourceId)}) r
    WHERE r.id IS NOT NULL ${after ? sql`AND r.id>${after}::uuid` : sql``}
    ORDER BY r.id LIMIT ${DERIVED_REFRESH_PAGE}
  `);
  return rows.rows.map(({ id }) => ({
    entityKind: route.entity,
    entityId: id,
    traverse: route.transitive === true,
  }));
}
