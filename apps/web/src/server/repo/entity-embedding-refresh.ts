import type { FinancialAccountIdentity } from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  entityEmbedding,
  expense,
  financialAccount,
  financialTransaction,
  gardenEntry,
  ingredient,
  inventoryEntry,
  location,
  meal,
  mealRecipe,
  planting,
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
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { solePurchaseForTransaction } from "~/server/repo/financial-transaction-allocations";
import { loadAllGtins } from "~/server/repo/product/gtin";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { embeddingTextHash } from "~/server/semantic/hash";
import {
  buildCookbookEmbeddingText,
  buildExpenseEmbeddingText,
  buildFinancialAccountEmbeddingText,
  buildFinancialTransactionEmbeddingText,
  buildGardenEntryEmbeddingText,
  buildIngredientEmbeddingText,
  buildInventoryEmbeddingText,
  buildLocationEmbeddingText,
  buildMealEmbeddingText,
  buildPlantingEmbeddingText,
  buildProductEmbeddingText,
  buildProjectEmbeddingText,
  buildPurchaseEmbeddingText,
  buildRecipeEmbeddingText,
  buildTaskEmbeddingText,
  buildVendorEmbeddingText,
  buildWishEmbeddingText,
  normalizeSearchText,
} from "~/server/semantic/text";

/** Mirrors `GARDEN_ENTRY_KIND_LABELS` in `repo/garden/index.ts` — that map is
 * private to the garden module, and `kind` is a plain `text` column here, not
 * the branded enum, so the label is re-derived rather than imported. */
const GARDEN_ENTRY_KIND_LABEL = {
  note: "Note",
  harvest: "Harvest",
} satisfies Record<string, string>;

function isGardenEntryKindLabel(
  kind: string,
): kind is keyof typeof GARDEN_ENTRY_KIND_LABEL {
  return kind in GARDEN_ENTRY_KIND_LABEL;
}

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
  db: Database | DrizzleTransaction,
  options?: EmbeddingLoadOptions,
) => Promise<SearchableEntityText[]>;

const withOptionalLimit = <const TConfig extends object>(
  config: TConfig,
  limit: number | undefined,
) => (limit === undefined ? config : { ...config, limit });

/**
 * The stored hash for an entity under the current model, or null when there is
 * no live row.
 *
 * Exposed so callers can decide BEFORE paying for an embedding.
 * `upsertEntityEmbeddingIfCurrent` is the live write path and runs the same
 * comparison implicitly (via `embeddingHash`), but only after the provider
 * has already been called and billed — that check saves the HNSW write, not the
 * request. Mutation-sourced refreshes carry no expected hash and fan out on
 * every edit, so without a pre-call gate an entity is re-embedded whenever any
 * of its projected text is rewritten, identical or not.
 */
export async function getStoredEmbeddingHash(
  db: Database | DrizzleTransaction,
  input: {
    entityType: SearchableEntity;
    entityId: string;
    config: SemanticEmbeddingConfig;
  },
): Promise<string | null> {
  const existing = await unwrapDb(db).query.entityEmbedding.findFirst({
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

export interface EntityEmbeddingUpsert extends SearchableEntityText {
  /**
   * The hash the caller already compared against the stored one. Passed in
   * rather than recomputed so the value that decided to pay for the vector is
   * the value stored beside it.
   */
  embeddingHash: string;
  config: SemanticEmbeddingConfig;
  embedding: number[];
}

/** One bound `'[…]'::vector` parameter, never an inlined literal. */
const vectorParam = (embedding: number[]): SQL => {
  if (
    embedding.length === 0 ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Invalid embedding vector");
  }
  return sql`${`[${embedding.join(",")}]`}::vector`;
};

/**
 * Write one vector only if the projection it was computed for is still the
 * live projection.
 *
 * The provider call happened outside any transaction, so by the time the
 * vector arrives the entity may have been edited again or deleted. Joining
 * the write to `SearchDocument` on the exact text that was embedded makes the
 * check and the write one statement: a newer projection never receives an
 * older vector, and a soft-deleted document never gets a vector resurrected.
 * `"obsolete"` means exactly that — the caller should not retry with the same
 * vector; the next refresh task (or "Settle now") will embed the current text.
 */
export async function upsertEntityEmbeddingIfCurrent(
  db: Database | DrizzleTransaction,
  input: EntityEmbeddingUpsert,
): Promise<"written" | "obsolete"> {
  const result = await unwrapDb(db).execute<{ entityId: string }>(sql`
    INSERT INTO "EntityEmbedding" (
      "entityType", "entityId", "embeddingText", "embeddingHash",
      provider, model, dimensions, embedding, "updatedAt"
    )
    SELECT sd."entityType", sd."entityId", sd."semanticText",
      ${input.embeddingHash}::text, ${input.config.provider}::text,
      ${input.config.model}::text, ${input.config.dimensions}::integer,
      ${vectorParam(input.embedding)}, now()
    FROM "SearchDocument" sd
    WHERE sd."entityType" = ${input.entityType}
      AND sd."entityId" = ${input.entityId}::uuid
      AND sd."deletedAt" IS NULL
      AND sd."semanticText" = ${input.embeddingText}::text
    ON CONFLICT ("entityType", "entityId", provider, model, dimensions)
      WHERE "deletedAt" IS NULL
    DO UPDATE SET
      "embeddingText" = EXCLUDED."embeddingText",
      "embeddingHash" = EXCLUDED."embeddingHash",
      embedding = EXCLUDED.embedding,
      "updatedAt" = now()
    RETURNING "entityId"::text AS "entityId"
  `);
  return result.rows.length > 0 ? "written" : "obsolete";
}

/**
 * Test-only seed for an `EntityEmbedding` row, upserted by content hash.
 *
 * This is NOT the production write path — that is
 * `upsertEntityEmbeddingIfCurrent`, which requires a matching
 * `SearchDocument.semanticText` row and only writes when the projection it
 * was computed for is still current. Integration tests that need a row
 * present without seeding a `SearchDocument` too (e.g. to assert removal
 * cascades soft-delete it) use this instead. Lives here rather than inline in
 * the calling test because services code cannot import DB schema/helpers
 * directly (`no-restricted-imports` on `apps/web/src/server/services/**`).
 */
export async function seedEntityEmbedding(
  db: Database | DrizzleTransaction,
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

  const existing = await unwrapDb(db).query.entityEmbedding.findFirst({
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

  if (existing) {
    await unwrapDb(db)
      .update(entityEmbedding)
      .set(values)
      .where(eq(entityEmbedding.id, existing.id));
    return;
  }

  await unwrapDb(db).insert(entityEmbedding).values(values);
}

async function getProductEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.product.findMany(queryConfig);
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
            product: {
              columns: { name: true, manufacturer: true, model: true },
            },
          },
        },
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.wish.findMany(queryConfig);
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.location.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "location",
    entityId: row.id,
    embeddingText: buildLocationEmbeddingText(row),
  }));
}

async function getIngredientEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.ingredient.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "ingredient",
    entityId: row.id,
    embeddingText: buildIngredientEmbeddingText(row),
  }));
}

async function getRecipeEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.cookbook.findMany(queryConfig);
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.project.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "project",
    entityId: row.id,
    embeddingText: buildProjectEmbeddingText(row),
  }));
}

async function getTaskEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.vendor.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "vendor",
    entityId: row.id,
    embeddingText: buildVendorEmbeddingText(row),
  }));
}

async function getPurchaseEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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

const presentIdentityTerms = (terms: Array<string | null>): string[] =>
  terms.filter((term): term is string => term !== null && term.length > 0);

const identityTerms = (identity: FinancialAccountIdentity): string[] => {
  switch (identity.kind) {
    case "credit_card":
      return presentIdentityTerms([
        identity.kind,
        identity.issuer,
        identity.network,
        identity.last4,
      ]);
    case "bank_account":
      return presentIdentityTerms([
        identity.kind,
        identity.institution,
        identity.accountType,
        identity.last4,
      ]);
    case "stored_value":
      return presentIdentityTerms([
        identity.kind,
        identity.provider,
        identity.last4,
      ]);
    case "cash":
      return [identity.kind];
    case "other":
      return presentIdentityTerms([
        identity.kind,
        identity.institution,
        identity.last4,
      ]);
  }
};

async function getFinancialAccountEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
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
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.financialAccount.findMany(queryConfig);
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
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = unwrapDb(db)
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

async function getPlantingEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(planting),
        options.ids?.length
          ? inArray(
              planting.id,
              options.ids.map((id) => parseEntityId("planting", id)),
            )
          : undefined,
      ),
      columns: { id: true, variety: true, status: true, notes: true },
      with: {
        ingredient: { columns: { name: true } },
        location: { columns: { name: true } },
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.planting.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "planting",
    entityId: row.id,
    embeddingText: buildPlantingEmbeddingText({
      ingredientName: row.ingredient.name,
      variety: row.variety,
      status: row.status,
      locationName: row.location?.name ?? null,
      notes: row.notes,
    }),
  }));
}

async function getGardenEntryEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(gardenEntry),
        options.ids?.length
          ? inArray(
              gardenEntry.id,
              options.ids.map((id) => parseEntityId("gardenEntry", id)),
            )
          : undefined,
      ),
      columns: {
        id: true,
        kind: true,
        observedOn: true,
        note: true,
        harvestAmount: true,
      },
      with: {
        location: { columns: { name: true } },
        planting: {
          columns: { variety: true },
          with: { ingredient: { columns: { name: true } } },
        },
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.gardenEntry.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "gardenEntry",
    entityId: row.id,
    embeddingText: buildGardenEntryEmbeddingText({
      kindLabel: isGardenEntryKindLabel(row.kind)
        ? GARDEN_ENTRY_KIND_LABEL[row.kind]
        : "Move",
      observedOn: row.observedOn,
      locationName: row.location.name,
      plantingName: row.planting
        ? row.planting.variety
          ? `${row.planting.ingredient.name} · ${row.planting.variety}`
          : row.planting.ingredient.name
        : null,
      note: row.note,
      harvestAmount: row.harvestAmount,
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
  planting: getPlantingEmbeddingTexts,
  gardenEntry: getGardenEntryEmbeddingTexts,
} satisfies Record<SearchableEntity, EmbeddingTextLoader>;

export async function getEmbeddingTextsForEntityTypes(
  db: Database | DrizzleTransaction,
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
  db: Database | DrizzleTransaction,
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
