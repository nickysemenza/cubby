import { parseEntityId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  cookbook,
  entityEmbedding,
  expense,
  financialAccount,
  financialTransaction,
  ingredient,
  inventoryEntry,
  location,
  meal,
  mealRecipe,
  product,
  project,
  purchase,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  task,
  vendor,
  wish,
  wishCandidate,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { solePurchaseForTransaction } from "~/server/repo/financial-transaction-allocations";
import { loadAllGtins } from "~/server/repo/product/gtin";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { embeddingTextHash } from "~/server/semantic/hash";
import {
  buildCookbookEmbeddingText,
  buildExpenseEmbeddingText,
  buildFinancialAccountEmbeddingText,
  buildFinancialTransactionEmbeddingText,
  buildIngredientEmbeddingText,
  buildInventoryEmbeddingText,
  buildLocationEmbeddingText,
  buildMealEmbeddingText,
  buildProductEmbeddingText,
  buildProjectEmbeddingText,
  buildPurchaseEmbeddingText,
  buildRecipeEmbeddingText,
  buildTaskEmbeddingText,
  buildVendorEmbeddingText,
  buildWishEmbeddingText,
  normalizeSearchText,
} from "~/server/semantic/text";

export interface SearchableEntityText {
  entityType: SearchableEntity;
  entityId: string;
  embeddingText: string;
}

interface EmbeddingLoadOptions {
  ids?: string[];
  limit?: number;
}

type EmbeddingTextLoader = (
  db: Database,
  options?: EmbeddingLoadOptions,
) => Promise<SearchableEntityText[]>;

/**
 * The stored hash for an entity under the current model, or null when there is
 * no live row.
 *
 * Exposed so callers can decide BEFORE paying for an embedding.
 * `upsertEntityEmbedding` runs the same comparison, but only after the provider
 * has already been called and billed — that check saves the HNSW write, not the
 * request. Mutation-sourced refreshes carry no expected hash and fan out on
 * every edit, so without a pre-call gate an entity is re-embedded whenever any
 * of its projected text is rewritten, identical or not.
 */
export async function getStoredEmbeddingHash(
  db: Database,
  input: {
    entityType: SearchableEntity;
    entityId: string;
    config: SemanticEmbeddingConfig;
  },
): Promise<string | null> {
  const existing = await getDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityType, input.entityType),
      eq(entityEmbedding.entityId, input.entityId),
      eq(entityEmbedding.provider, input.config.provider),
      eq(entityEmbedding.model, input.config.model),
      eq(entityEmbedding.dimensions, input.config.dimensions),
      notDeleted(entityEmbedding),
    ),
    columns: { embeddingHash: true },
  });
  return existing?.embeddingHash ?? null;
}

export async function upsertEntityEmbedding(
  db: Database,
  input: SearchableEntityText & {
    config: SemanticEmbeddingConfig;
    embedding: number[];
  },
): Promise<void> {
  const embeddingHash = await embeddingTextHash({
    entityType: input.entityType,
    provider: input.config.provider,
    model: input.config.model,
    dimensions: input.config.dimensions,
    text: normalizeSearchText(input.embeddingText),
  });

  const existing = await getDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityType, input.entityType),
      eq(entityEmbedding.entityId, input.entityId),
      eq(entityEmbedding.provider, input.config.provider),
      eq(entityEmbedding.model, input.config.model),
      eq(entityEmbedding.dimensions, input.config.dimensions),
      notDeleted(entityEmbedding),
    ),
    columns: { id: true, embeddingHash: true },
  });

  if (existing?.embeddingHash === embeddingHash) return;

  const values = {
    entityType: input.entityType,
    entityId: input.entityId,
    embeddingText: input.embeddingText,
    embeddingHash,
    provider: input.config.provider,
    model: input.config.model,
    dimensions: input.config.dimensions,
    embedding: input.embedding,
    deletedAt: null,
  };

  // Deliberately NOT `updateAndReturn`/`insertAndReturn`: those `RETURNING *`,
  // which ships the 1536-float vector back over the wire and re-parses it into
  // a JS array via `pgVector.fromDriver` (~30 KB per write) — and this function
  // returns void, so every byte of it is discarded. Writes here are already the
  // hot path: each one rewrites a 258 MB HNSW entry. The driver-level
  // `traceQuery` span in db.ts still covers these, so no observability is lost.
  if (existing) {
    await getDb(db)
      .update(entityEmbedding)
      .set(values)
      .where(eq(entityEmbedding.id, existing.id));
    return;
  }

  await getDb(db).insert(entityEmbedding).values(values);
}

async function getProductEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.product.findMany({
    where: and(
      notDeleted(product),
      options.ids?.length
        ? inArray(
            product.id,
            options.ids.map((id) => parseEntityId("product", id)),
          )
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      category: true,
      model: true,
      notes: true,
      aliases: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  const gtins = await loadAllGtins(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    entityType: "product",
    entityId: row.id,
    embeddingText: buildProductEmbeddingText({
      ...row,
      gtins: gtins.get(row.id) ?? [],
    }),
  }));
}

async function getWishEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.wish.findMany({
    where: and(
      notDeleted(wish),
      options.ids?.length
        ? inArray(
            wish.id,
            options.ids.map((id) => parseEntityId("wish", id)),
          )
        : undefined,
    ),
    columns: { id: true, name: true, notes: true },
    with: {
      candidates: {
        where: notDeleted(wishCandidate),
        with: {
          product: { columns: { name: true, manufacturer: true, model: true } },
        },
      },
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "wish",
    entityId: row.id,
    embeddingText: buildWishEmbeddingText({
      name: row.name,
      notes: row.notes,
      candidateTerms: row.candidates.flatMap((candidate) =>
        candidate.product
          ? [
              candidate.product.name,
              candidate.product.manufacturer,
              candidate.product.model,
            ]
          : [],
      ),
    }),
  }));
}

async function getLocationEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.location.findMany({
    where: and(
      notDeleted(location),
      options.ids?.length
        ? inArray(
            location.id,
            options.ids.map((id) => parseEntityId("location", id)),
          )
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      type: true,
      aiDescription: true,
      aliases: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "location",
    entityId: row.id,
    embeddingText: buildLocationEmbeddingText(row),
  }));
}

async function getIngredientEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.ingredient.findMany({
    where: and(
      notDeleted(ingredient),
      isNull(ingredient.recipeId),
      options.ids?.length
        ? inArray(
            ingredient.id,
            options.ids.map((id) => parseEntityId("ingredient", id)),
          )
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      aliases: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "ingredient",
    entityId: row.id,
    embeddingText: buildIngredientEmbeddingText(row),
  }));
}

async function getRecipeEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: recipe.id,
      name: recipe.name,
      tags: recipe.tags,
      notes: recipe.notes,
      ingredientNames: sql<
        string[]
      >`array_remove(array_agg(DISTINCT ${ingredient.name}), NULL)`.as(
        "ingredientNames",
      ),
    })
    .from(recipe)
    .leftJoin(recipeSection, eq(recipeSection.recipeId, recipe.id))
    .leftJoin(
      recipeSectionIngredient,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .leftJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .where(
      and(
        notDeleted(recipe),
        options.ids?.length
          ? inArray(
              recipe.id,
              options.ids.map((id) => parseEntityId("recipe", id)),
            )
          : undefined,
      ),
    )
    .groupBy(recipe.id);
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

  return rows.map((row) => ({
    entityType: "recipe",
    entityId: row.id,
    embeddingText: buildRecipeEmbeddingText(row),
  }));
}

async function getCookbookEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.cookbook.findMany({
    where: and(
      notDeleted(cookbook),
      options.ids?.length
        ? inArray(
            cookbook.id,
            options.ids.map((id) => parseEntityId("cookbook", id)),
          )
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      author: true,
      subjects: true,
      sourceLabel: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "cookbook",
    entityId: row.id,
    embeddingText: buildCookbookEmbeddingText(row),
  }));
}

// A meal is usually unnamed, so the planned recipes' names carry most of its
// searchable identity — aggregated here the same way recipes fold in their
// ingredient names.
async function getMealEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: meal.id,
      name: meal.name,
      date: meal.date,
      mealType: meal.mealType,
      mealKind: meal.mealKind,
      recipeNames: sql<
        string[]
      >`array_remove(array_agg(DISTINCT ${recipe.name}), NULL)`.as(
        "recipeNames",
      ),
    })
    .from(meal)
    .leftJoin(
      mealRecipe,
      and(eq(mealRecipe.mealId, meal.id), notDeleted(mealRecipe)),
    )
    .leftJoin(
      recipe,
      and(eq(recipe.id, mealRecipe.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(meal),
        options.ids?.length
          ? inArray(
              meal.id,
              options.ids.map((id) => parseEntityId("meal", id)),
            )
          : undefined,
      ),
    )
    .groupBy(meal.id);
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

  return rows.map((row) => ({
    entityType: "meal",
    entityId: row.id,
    embeddingText: buildMealEmbeddingText(row),
  }));
}

async function getInventoryEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: inventoryEntry.id,
      amount: inventoryEntry.amount,
      locationName: location.name,
      productName: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
      model: product.model,
      productId: product.id,
      notes: product.notes,
      aliases: product.aliases,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .innerJoin(location, eq(inventoryEntry.locationId, location.id))
    .where(
      and(
        notDeleted(inventoryEntry),
        notDeleted(product),
        notDeleted(location),
        options.ids?.length
          ? inArray(
              inventoryEntry.id,
              options.ids.map((id) => parseEntityId("inventory", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  const gtins = await loadAllGtins(
    db,
    rows.map((row) => row.productId),
  );

  return rows.map((row) => ({
    entityType: "inventory",
    entityId: row.id,
    embeddingText: buildInventoryEmbeddingText({
      productText: buildProductEmbeddingText({
        name: row.productName,
        manufacturer: row.manufacturer,
        category: row.category,
        model: row.model,
        gtins: gtins.get(row.productId) ?? [],
        notes: row.notes,
        aliases: row.aliases,
      }),
      locationPath: row.locationName,
      amount: row.amount,
    }),
  }));
}

async function getProjectEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.project.findMany({
    where: and(
      notDeleted(project),
      options.ids?.length
        ? inArray(
            project.id,
            options.ids.map((id) => parseEntityId("project", id)),
          )
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      status: true,
      kind: true,
      locations: true,
      notes: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "project",
    entityId: row.id,
    embeddingText: buildProjectEmbeddingText(row),
  }));
}

async function getTaskEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: task.id,
      name: task.name,
      status: task.status,
      trade: task.trade,
      projectName: project.name,
      subjectProductName: product.name,
    })
    .from(task)
    .leftJoin(project, eq(task.projectId, project.id))
    .leftJoin(product, eq(task.subjectProductId, product.id))
    .where(
      and(
        notDeleted(task),
        options.ids?.length
          ? inArray(
              task.id,
              options.ids.map((id) => parseEntityId("task", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityType: "task",
    entityId: row.id,
    embeddingText: buildTaskEmbeddingText(row),
  }));
}

async function getExpenseEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: expense.id,
      name: expense.name,
      lineKind: expense.lineKind,
      costType: expense.costType,
      trade: expense.trade,
      notes: expense.notes,
      projectName: project.name,
      vendorName: vendor.name,
      orderId: purchase.orderId,
    })
    .from(expense)
    .leftJoin(project, eq(expense.projectId, project.id))
    .leftJoin(
      purchase,
      and(eq(expense.purchaseId, purchase.id), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)))
    .where(
      and(
        notDeleted(expense),
        options.ids?.length
          ? inArray(
              expense.id,
              options.ids.map((id) => parseEntityId("expense", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityType: "expense",
    entityId: row.id,
    embeddingText: buildExpenseEmbeddingText(row),
  }));
}

async function getVendorEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.vendor.findMany({
    where: and(
      notDeleted(vendor),
      options.ids?.length
        ? inArray(
            vendor.id,
            options.ids.map((id) => parseEntityId("vendor", id)),
          )
        : undefined,
    ),
    columns: { id: true, name: true, website: true, notes: true },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "vendor",
    entityId: row.id,
    embeddingText: buildVendorEmbeddingText(row),
  }));
}

async function getPurchaseEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: purchase.id,
      vendorName: vendor.name,
      orderId: purchase.orderId,
      displayLabel: purchase.displayLabel,
      date: purchase.date,
      notes: purchase.notes,
    })
    .from(purchase)
    .innerJoin(
      vendor,
      and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)),
    )
    .where(
      and(
        notDeleted(purchase),
        options.ids?.length
          ? inArray(
              purchase.id,
              options.ids.map((id) => parseEntityId("purchase", id)),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityType: "purchase",
    entityId: row.id,
    embeddingText: buildPurchaseEmbeddingText(row),
  }));
}

const identityTerms = (identity: Record<string, unknown>): string[] =>
  Object.values(identity).flatMap((value) =>
    typeof value === "string" && value.length > 0 ? [value] : [],
  );

async function getFinancialAccountEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.financialAccount.findMany({
    where: and(
      notDeleted(financialAccount),
      options.ids?.length
        ? inArray(
            financialAccount.id,
            options.ids.map((id) => parseEntityId("financialAccount", id)),
          )
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      identity: true,
      sourceAliases: true,
      notes: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "financialAccount",
    entityId: row.id,
    embeddingText: buildFinancialAccountEmbeddingText({
      name: row.name,
      identityTerms: identityTerms(row.identity),
      sourceAliasTerms: row.sourceAliases.flatMap((alias) => [
        alias.source,
        alias.alias,
        alias.externalAccountId,
      ]),
      notes: row.notes,
    }),
  }));
}

async function getFinancialTransactionEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: financialTransaction.id,
      merchant: financialTransaction.merchant,
      rawDescription: financialTransaction.rawDescription,
      sourceCategory: financialTransaction.sourceCategory,
      sourceRefs: financialTransaction.sourceRefs,
      notes: financialTransaction.notes,
      accountName: financialAccount.name,
      vendorName: vendor.name,
      orderId: purchase.orderId,
      kind: financialTransaction.kind,
      status: financialTransaction.status,
      transactionDate: financialTransaction.transactionDate,
      postedDate: financialTransaction.postedDate,
    })
    .from(financialTransaction)
    .innerJoin(
      financialAccount,
      and(
        eq(financialTransaction.accountId, financialAccount.id),
        notDeleted(financialAccount),
      ),
    )
    // Resolved through the allocation table, so a split transaction still gets a
    // vendor and order in its embedded text instead of the NULL its mirror now
    // holds. The correlated pick keeps exactly one row per transaction: a split
    // contributes its first purchase by id rather than all of them, which is a
    // deliberate narrowing — aggregating several vendors into one subtitle is
    // not worth it for the handful of rows that will ever be split.
    .leftJoin(
      purchase,
      and(eq(purchase.id, solePurchaseForTransaction), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)))
    .where(
      and(
        notDeleted(financialTransaction),
        options.ids?.length
          ? inArray(
              financialTransaction.id,
              options.ids.map((id) =>
                parseEntityId("financialTransaction", id),
              ),
            )
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityType: "financialTransaction",
    entityId: row.id,
    embeddingText: buildFinancialTransactionEmbeddingText({
      ...row,
      sourceRefTerms: row.sourceRefs.flatMap((ref) => [
        ref.source,
        ref.externalId,
      ]),
    }),
  }));
}

const embeddingTextLoaders = {
  product: getProductEmbeddingTexts,
  recipe: getRecipeEmbeddingTexts,
  ingredient: getIngredientEmbeddingTexts,
  cookbook: getCookbookEmbeddingTexts,
  location: getLocationEmbeddingTexts,
  inventory: getInventoryEmbeddingTexts,
  meal: getMealEmbeddingTexts,
  project: getProjectEmbeddingTexts,
  task: getTaskEmbeddingTexts,
  vendor: getVendorEmbeddingTexts,
  purchase: getPurchaseEmbeddingTexts,
  financialAccount: getFinancialAccountEmbeddingTexts,
  financialTransaction: getFinancialTransactionEmbeddingTexts,
  expense: getExpenseEmbeddingTexts,
  wish: getWishEmbeddingTexts,
} satisfies Record<SearchableEntity, EmbeddingTextLoader>;

export async function getEmbeddingTextsForEntityTypes(
  db: Database,
  entityTypes: SearchableEntity[],
  limit?: number,
): Promise<SearchableEntityText[]> {
  const perTypeLimit =
    limit == null
      ? undefined
      : Math.max(1, Math.ceil(limit / entityTypes.length));
  const chunks = await Promise.all(
    entityTypes.map((entityType) =>
      embeddingTextLoaders[entityType](db, { limit: perTypeLimit }),
    ),
  );
  const rows = chunks.flat();
  return limit == null ? rows : rows.slice(0, limit);
}

/**
 * One loader call per entity type for a whole set of ids. This replaced a
 * per-entity form that issued a single-id SELECT for every row in a refresh
 * wave — 3,945 of them in one production sample.
 */
export async function getEmbeddingTextsForRefs(
  db: Database,
  idsByType: ReadonlyMap<SearchableEntity, string[]>,
): Promise<SearchableEntityText[]> {
  const chunks = await Promise.all(
    [...idsByType].map(([entityType, ids]) =>
      ids.length === 0
        ? Promise.resolve<SearchableEntityText[]>([])
        : embeddingTextLoaders[entityType](db, { ids }),
    ),
  );
  return chunks.flat();
}
