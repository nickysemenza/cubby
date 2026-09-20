import type {
  ExpenseId,
  FinancialAccountId,
  IngredientId,
  LocationId,
  ProductId,
  PlantingId,
  ProjectId,
  PurchaseId,
  RecipeId,
  VendorId,
} from "@cubby/schemas/identifiers";
import {
  type SearchableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityEmbedding,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  gardenEntry,
  gardenEntryPlanting,
  inventoryEntry,
  meal,
  mealRecipe,
  planting,
  purchase,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  searchDocument,
  task,
  vendor,
  wish,
  wishCandidate,
} from "~/server/db/schema";
import {
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  getOrphanedSearchDocumentRefs,
  type SearchDocumentCursor,
} from "~/server/repo/search-document";

async function softDeleteEntityEmbeddingsTx(
  tx: DrizzleTransaction,
  entityType: SearchableEntity,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await tx
    .update(entityEmbedding)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(entityEmbedding.entityType, entityType),
        inArray(entityEmbedding.entityId, entityIds),
        notDeleted(entityEmbedding),
      ),
    );
}

/** Revalidate persisted candidates and retire both artifacts atomically. */
export async function retireStillOrphanedSearchArtifacts(
  db: Database,
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<number> {
  if (refs.length === 0) return 0;
  return withTransaction(db, async (tx) => {
    const stillOrphaned = await getOrphanedSearchDocumentRefs(tx, refs);
    const byType = new Map<SearchableEntity, string[]>();
    for (const ref of stillOrphaned) {
      byType.set(ref.entityType, [
        ...(byType.get(ref.entityType) ?? []),
        ref.entityId,
      ]);
    }
    for (const [entityType, ids] of byType) {
      await softDeleteEntitySearchArtifactsTx(tx, entityType, ids);
    }
    return stillOrphaned.length;
  });
}

/**
 * Transactional removal cascade for every derived search artifact.
 *
 * `SearchDocument` and `EntityEmbedding` describe the same live entity at two
 * retrieval layers, so a removal must retire both rows atomically. Keep this
 * as the one removal-module entry point rather than teaching every delete and
 * merge path about the individual index tables.
 */
export async function softDeleteEntitySearchArtifactsTx(
  tx: DrizzleTransaction,
  entityType: SearchableEntity,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await softDeleteEntityEmbeddingsTx(tx, entityType, entityIds);
  await tx
    .update(searchDocument)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(searchDocument.entityType, entityType),
        inArray(searchDocument.entityId, entityIds),
        notDeleted(searchDocument),
      ),
    );
}

export async function getEntityEmbeddingDeletedAtForRef(
  db: Database | DrizzleTransaction,
  ref: SearchableEntityRef,
): Promise<Date | null | undefined> {
  const row = await unwrapDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityType, ref.entityType),
      eq(entityEmbedding.entityId, ref.entityId),
    ),
    columns: { deletedAt: true },
  });
  return row?.deletedAt;
}

export async function findInventoryEmbeddingRefsForProducts(
  db: Database | DrizzleTransaction,
  productIds: ProductId[],
): Promise<SearchableEntityRef[]> {
  if (productIds.length === 0) return [];
  const rows = await unwrapDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, productIds),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "inventory", entityId: row.id }));
}

/** Tasks embed their subject product's name, so a product rename must refresh
 * every live task that points at it. */
export async function findTaskEmbeddingRefsForProducts(
  db: Database | DrizzleTransaction,
  productIds: ProductId[],
): Promise<SearchableEntityRef[]> {
  if (productIds.length === 0) return [];
  const rows = await unwrapDb(db).query.task.findMany({
    where: and(inArray(task.subjectProductId, productIds), notDeleted(task)),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "task", entityId: row.id }));
}

/** Wishes embed candidate product identity, so Product identity edits fan out. */
export async function findWishEmbeddingRefsForProducts(
  db: Database | DrizzleTransaction,
  productIds: ProductId[],
): Promise<SearchableEntityRef[]> {
  if (productIds.length === 0) return [];
  const rows = await unwrapDb(db)
    .selectDistinct({ wishId: wishCandidate.wishId })
    .from(wishCandidate)
    .innerJoin(wish, eq(wish.id, wishCandidate.wishId))
    .where(
      and(
        inArray(wishCandidate.productId, productIds),
        notDeleted(wishCandidate),
        notDeleted(wish),
      ),
    );
  return rows.map((row) => ({ entityType: "wish", entityId: row.wishId }));
}

export async function findInventoryEmbeddingRefsForLocations(
  db: Database | DrizzleTransaction,
  locationIds: LocationId[],
): Promise<SearchableEntityRef[]> {
  if (locationIds.length === 0) return [];
  const rows = await unwrapDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.locationId, locationIds),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "inventory", entityId: row.id }));
}

export async function findRecipeEmbeddingRefsForIngredients(
  db: Database | DrizzleTransaction,
  ingredientIds: IngredientId[],
): Promise<SearchableEntityRef[]> {
  if (ingredientIds.length === 0) return [];
  const rows = await unwrapDb(db)
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        inArray(recipeSectionIngredient.ingredientId, ingredientIds),
        notDeleted(recipeSectionIngredient),
        notDeleted(recipeSection),
        notDeleted(recipe),
      ),
    );
  return rows.map((row) => ({ entityType: "recipe", entityId: row.recipeId }));
}

/** Plantings embed their ingredient's NAME, so a rename must refresh every
 * live planting sown for it. */
export async function findPlantingEmbeddingRefsForIngredients(
  db: Database | DrizzleTransaction,
  ingredientIds: IngredientId[],
): Promise<SearchableEntityRef[]> {
  if (ingredientIds.length === 0) return [];
  const rows = await unwrapDb(db).query.planting.findMany({
    where: and(
      inArray(planting.ingredientId, ingredientIds),
      notDeleted(planting),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "planting", entityId: row.id }));
}

/** Plantings embed their CURRENT location's name (title's subtitle), so a
 * location rename must refresh every live planting sitting there. */
export async function findPlantingEmbeddingRefsForLocations(
  db: Database | DrizzleTransaction,
  locationIds: LocationId[],
): Promise<SearchableEntityRef[]> {
  if (locationIds.length === 0) return [];
  const rows = await unwrapDb(db).query.planting.findMany({
    where: and(inArray(planting.locationId, locationIds), notDeleted(planting)),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "planting", entityId: row.id }));
}

/** Garden entries embed their location's NAME in the title, so a location
 * rename must refresh every live entry recorded there. */
export async function findGardenEntryEmbeddingRefsForLocations(
  db: Database | DrizzleTransaction,
  locationIds: LocationId[],
): Promise<SearchableEntityRef[]> {
  if (locationIds.length === 0) return [];
  const rows = await unwrapDb(db).query.gardenEntry.findMany({
    where: and(
      inArray(gardenEntry.locationId, locationIds),
      notDeleted(gardenEntry),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "gardenEntry", entityId: row.id }));
}

/** Garden entries embed the names of their linked plantings. */
export async function findGardenEntryEmbeddingRefsForPlantings(
  db: Database | DrizzleTransaction,
  plantingIds: PlantingId[],
): Promise<SearchableEntityRef[]> {
  if (plantingIds.length === 0) return [];
  const rows = await unwrapDb(db)
    .select({ id: gardenEntry.id })
    .from(gardenEntryPlanting)
    .innerJoin(
      gardenEntry,
      eq(gardenEntry.id, gardenEntryPlanting.gardenEntryId),
    )
    .where(
      and(
        inArray(gardenEntryPlanting.plantingId, plantingIds),
        notDeleted(gardenEntryPlanting),
        notDeleted(gardenEntry),
      ),
    );
  return rows.map((row) => ({ entityType: "gardenEntry", entityId: row.id }));
}

/**
 * Meals embed the NAMES of the recipes planned into them, so a recipe rename
 * must refresh every live meal embedding that plans it.
 */
export async function findMealEmbeddingRefsForRecipes(
  db: Database | DrizzleTransaction,
  recipeIds: RecipeId[],
): Promise<SearchableEntityRef[]> {
  if (recipeIds.length === 0) return [];
  const rows = await unwrapDb(db)
    .selectDistinct({ mealId: mealRecipe.mealId })
    .from(mealRecipe)
    .innerJoin(meal, eq(meal.id, mealRecipe.mealId))
    .where(
      and(
        inArray(mealRecipe.recipeId, recipeIds),
        notDeleted(mealRecipe),
        notDeleted(meal),
      ),
    );
  return rows.map((row) => ({ entityType: "meal", entityId: row.mealId }));
}

/**
 * Tasks and expenses embed their project's NAME, so a project rename must
 * refresh every live task/expense embedding under it.
 */
export async function findTrackerEmbeddingRefsForProjects(
  db: Database | DrizzleTransaction,
  projectIds: ProjectId[],
): Promise<SearchableEntityRef[]> {
  if (projectIds.length === 0) return [];
  const [tasks, expenses] = await Promise.all([
    unwrapDb(db).query.task.findMany({
      where: and(inArray(task.projectId, projectIds), notDeleted(task)),
      columns: { id: true },
    }),
    unwrapDb(db).query.expense.findMany({
      where: and(inArray(expense.projectId, projectIds), notDeleted(expense)),
      columns: { id: true },
    }),
  ]);
  return [
    ...tasks.map((row): SearchableEntityRef => ({
      entityType: "task",
      entityId: row.id,
    })),
    ...expenses.map((row): SearchableEntityRef => ({
      entityType: "expense",
      entityId: row.id,
    })),
  ];
}

/** Purchases and their downstream ledger/settlement records embed vendor identity. */
export async function findEmbeddingRefsForVendors(
  db: Database | DrizzleTransaction,
  vendorIds: VendorId[],
): Promise<SearchableEntityRef[]> {
  if (vendorIds.length === 0) return [];
  const purchases = await unwrapDb(db).query.purchase.findMany({
    where: and(inArray(purchase.vendorId, vendorIds), notDeleted(purchase)),
    columns: { id: true },
  });
  return findEmbeddingRefsForPurchases(
    db,
    purchases.map((row) => row.id),
    true,
  );
}

/** Expenses and settlement transactions embed their linked Purchase identity. */
export async function findEmbeddingRefsForPurchases(
  db: Database | DrizzleTransaction,
  purchaseIds: PurchaseId[],
  includePurchases = false,
): Promise<SearchableEntityRef[]> {
  if (purchaseIds.length === 0) return [];
  const [expenses, transactions] = await Promise.all([
    unwrapDb(db).query.expense.findMany({
      where: and(inArray(expense.purchaseId, purchaseIds), notDeleted(expense)),
      columns: { id: true },
    }),
    // Through allocations, not the mirror: a transaction split across two
    // purchases has a NULL mirror, so the mirror alone would fail to re-embed
    // it and leave a stale vendor/order in its embedding text. This is a
    // removal-path invariant site — missing a transaction here leaks an
    // orphaned embedding.
    unwrapDb(db)
      .selectDistinct({ id: financialTransactionAllocation.transactionId })
      .from(financialTransactionAllocation)
      .innerJoin(
        financialTransaction,
        and(
          eq(
            financialTransaction.id,
            financialTransactionAllocation.transactionId,
          ),
          notDeleted(financialTransaction),
        ),
      )
      .where(
        and(
          inArray(financialTransactionAllocation.purchaseId, purchaseIds),
          notDeleted(financialTransactionAllocation),
        ),
      ),
  ]);
  return [
    ...(includePurchases
      ? purchaseIds.map((entityId): SearchableEntityRef => ({
          entityType: "purchase",
          entityId,
        }))
      : []),
    ...expenses.map((row): SearchableEntityRef => ({
      entityType: "expense",
      entityId: row.id,
    })),
    ...transactions.map((row): SearchableEntityRef => ({
      entityType: "financialTransaction",
      entityId: row.id,
    })),
  ];
}

/** Transactions embed their account's display identity. */
export async function findTransactionEmbeddingRefsForAccounts(
  db: Database | DrizzleTransaction,
  accountIds: FinancialAccountId[],
): Promise<SearchableEntityRef[]> {
  if (accountIds.length === 0) return [];
  const rows = await unwrapDb(db).query.financialTransaction.findMany({
    where: and(
      inArray(financialTransaction.accountId, accountIds),
      notDeleted(financialTransaction),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({
    entityType: "financialTransaction",
    entityId: row.id,
  }));
}

/** Expense writes can create Purchase/Vendor rows implicitly during resolution. */
export async function findCommercialEmbeddingRefsForExpenses(
  db: Database | DrizzleTransaction,
  expenseIds: ExpenseId[],
): Promise<SearchableEntityRef[]> {
  if (expenseIds.length === 0) return [];
  const rows = await unwrapDb(db)
    .selectDistinct({ purchaseId: purchase.id, vendorId: vendor.id })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
    )
    .innerJoin(
      vendor,
      and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)),
    )
    .where(and(inArray(expense.id, expenseIds), notDeleted(expense)));
  return rows.flatMap((row): SearchableEntityRef[] => [
    { entityType: "purchase", entityId: row.purchaseId },
    { entityType: "vendor", entityId: row.vendorId },
  ]);
}

const RECONCILE_PAGE_SIZE = 500;

/**
 * One keyset page of `SearchDocument` refs soft-deleted since `since`, for
 * the daily Vectorize reconcile: each ref's vector is safe to `deleteByIds`.
 *
 * includes-deleted: intentionally reads soft-deleted `SearchDocument` rows —
 * that is the whole point, finding vectors Vectorize should drop.
 * `EntityEmbedding.deletedAt` cannot stand in for this: an entity that was
 * embedded but never got a slim `EntityEmbedding` row (create-then-delete
 * before its first refresh, or a truncated table) has no soft-delete marker
 * there to find, only in `SearchDocument`.
 *
 * DISTINCT on (entityType, entityId) and the NOT EXISTS guard both exist for
 * the same reason: `SearchDocument_live_entity_key` is a partial unique index
 * (`WHERE "deletedAt" IS NULL`), so `markSearchDocumentMissing` followed by a
 * later successful refresh inserts a second, live row for the same entity
 * rather than reviving the old one — the old row stays soft-deleted forever.
 * A naive "soft-deleted since X" scan would return that stale row and delete
 * a live entity's vector. NOT EXISTS excludes any entity that also has a live
 * twin; DISTINCT collapses the (rarer) case of two soft-deleted rows for one
 * entity into a single ref.
 */
export async function selectRecentlySoftDeletedSearchRefs(
  db: Database | DrizzleTransaction,
  options: { since: Date; cursor?: SearchDocumentCursor; limit?: number },
): Promise<{
  refs: Array<{ entityType: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
}> {
  const limit = Math.min(
    Math.max(options.limit ?? RECONCILE_PAGE_SIZE, 1),
    RECONCILE_PAGE_SIZE,
  );
  const cursor = options.cursor
    ? sql`AND (sd."entityType", sd."entityId") > (${options.cursor.entityType}, ${options.cursor.entityId}::uuid)`
    : sql``;
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
  }>(sql`
    SELECT DISTINCT sd."entityType", sd."entityId"::text AS "entityId"
    FROM "SearchDocument" sd
    WHERE sd."deletedAt" > ${options.since}
      AND NOT EXISTS (
        SELECT 1 FROM "SearchDocument" live
        WHERE live."entityType" = sd."entityType"
          AND live."entityId" = sd."entityId"
          AND live."deletedAt" IS NULL
      )
      ${cursor}
    ORDER BY sd."entityType", sd."entityId"::text
    LIMIT ${limit}
  `);
  const last = result.rows.at(-1);
  return {
    refs: result.rows,
    nextCursor:
      last && result.rows.length === limit
        ? { entityType: last.entityType, entityId: last.entityId }
        : null,
  };
}
