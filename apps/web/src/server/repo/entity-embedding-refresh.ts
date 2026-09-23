import { entityRefKey } from "@cubby/schemas/entity";
import type {
  FinancialAccountCardNumber,
  FinancialAccountIdentity,
} from "@cubby/schemas/financial-account";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  expense,
  financialAccount,
  financialTransaction,
  gardenEntry,
  gardenEntryPlanting,
  image,
  ingredient,
  inventoryEntry,
  location,
  meal,
  mealRecipe,
  plant,
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
import {
  plantDisplayName,
  plantingDisplayName,
} from "~/server/garden-guides/windows";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { solePurchaseForTransaction } from "~/server/repo/financial-transaction-allocations";
import { categorySummarySql } from "~/server/repo/product-category-sql";
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
  buildPlantEmbeddingText,
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

import { effectiveExpenseTradeSql } from "./expense-inheritance";
import { expenseProjectNamesSql } from "./expense-project-allocation";
import {
  effectiveProjectLocationsSql,
  effectiveTaskProjectSql,
  effectiveTaskSubjectProductSql,
  effectiveTaskTradeSql,
} from "./task-project-inheritance";

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
 * One query for a whole refresh wave (or a single ref, from
 * {@link getEntityEmbeddingReadiness}) instead of one per ref, keyed
 * `${entityType}:${entityId}` so a caller can compare against a locally
 * computed hash without a second lookup.
 *
 * Exposed so callers can decide BEFORE paying for an embedding.
 * `upsertEntityEmbeddingsIfCurrent` is the live write path and runs the same
 * comparison implicitly (via `embeddingHash`), but only after the provider
 * has already been called and billed — that check saves the HNSW write, not
 * the request. Mutation-sourced refreshes carry no expected hash and fan out
 * on every edit, so without a pre-call gate an entity is re-embedded
 * whenever any of its projected text is rewritten, identical or not.
 *
 * Refs with no live row under the config's (provider, model, dimensions) are
 * simply absent from the map.
 */
export async function getStoredEmbeddingHashes(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<SearchableEntityRef>,
  config: SemanticEmbeddingConfig,
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map();
  // A JS array interpolates as a row constructor, not a Postgres list — build
  // the VALUES rows with `sql.join`, mirroring `getSearchDocumentEmbeddingTexts`.
  const values = sql.join(
    refs.map((ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
    embeddingHash: string;
  }>(sql`
    WITH refs("entityType", "entityId") AS (VALUES ${values})
    SELECT ee."entityType", ee."entityId"::text AS "entityId",
      ee."embeddingHash"
    FROM refs
    JOIN "EntityEmbedding" ee
      ON ee."entityType" = refs."entityType"
      AND ee."entityId" = refs."entityId"
      AND ee.provider = ${config.provider}::text
      AND ee.model = ${config.model}::text
      AND ee.dimensions = ${config.dimensions}::integer
      AND ee."deletedAt" IS NULL
  `);
  return new Map(
    result.rows.map((row) => [
      `${row.entityType}:${row.entityId}`,
      row.embeddingHash,
    ]),
  );
}

export interface EntityEmbeddingUpsert extends SearchableEntityText {
  /**
   * The hash the caller already compared against the stored one. Passed in
   * rather than recomputed so the value that decided to pay for the vector is
   * the value stored beside it.
   */
  embeddingHash: string;
  config: SemanticEmbeddingConfig;
}

/**
 * Write vectors' bookkeeping rows only where the projection each was
 * computed for is still the live projection — one statement for a whole
 * refresh wave instead of one round trip per ref.
 *
 * Each provider call happened outside any transaction, so by the time a
 * vector arrives its entity may have been edited again or deleted. Joining
 * the write to `SearchDocument` on the exact text that was embedded makes the
 * check and the write one statement: a newer projection never receives an
 * older vector, and a soft-deleted document never gets a vector resurrected.
 * A ref absent from the returned set means exactly that — the caller should
 * not retry with the same vector; the next refresh task (or "Settle now")
 * will embed the current text.
 */
export async function upsertEntityEmbeddingsIfCurrent(
  db: Database | DrizzleTransaction,
  inputs: ReadonlyArray<EntityEmbeddingUpsert>,
): Promise<Set<string>> {
  if (inputs.length === 0) return new Set();
  // A JS array interpolates as a row constructor, not a Postgres list — build
  // the VALUES rows with `sql.join`, mirroring `getStoredEmbeddingHashes`.
  const values = sql.join(
    inputs.map(
      (input) =>
        sql`(${input.entityType}::text, ${input.entityId}::uuid, ${input.embeddingText}::text, ${input.embeddingHash}::text, ${input.config.provider}::text, ${input.config.model}::text, ${input.config.dimensions}::int)`,
    ),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
  }>(sql`
    INSERT INTO "EntityEmbedding" (
      "entityType", "entityId", "embeddingText", "embeddingHash",
      provider, model, dimensions, "updatedAt"
    )
    SELECT sd."entityType", sd."entityId", sd."semanticText",
      v."embeddingHash", v.provider, v.model, v.dimensions, now()
    FROM (VALUES ${values}) AS v(
      "entityType", "entityId", "embeddingText", "embeddingHash",
      provider, model, dimensions
    )
    JOIN "SearchDocument" sd
      ON sd."entityType" = v."entityType"
      AND sd."entityId" = v."entityId"
      AND sd."deletedAt" IS NULL
      AND sd."semanticText" = v."embeddingText"
    ON CONFLICT ("entityType", "entityId", provider, model, dimensions)
      WHERE "deletedAt" IS NULL
    DO UPDATE SET
      "embeddingText" = EXCLUDED."embeddingText",
      "embeddingHash" = EXCLUDED."embeddingHash",
      "updatedAt" = now()
    RETURNING "entityType", "entityId"::text AS "entityId"
  `);
  return new Set(
    result.rows.map((row) => entityRefKey(row.entityType, row.entityId)),
  );
}

/**
 * Test-only seed for an `EntityEmbedding` row: computes the hash and delegates
 * to the production write path, {@link upsertEntityEmbeddingsIfCurrent}, with
 * a one-element batch. That path requires a matching
 * `SearchDocument.semanticText` row, so callers must seed (or otherwise
 * produce) one with the same `embeddingText` first. Lives here rather than
 * inline in the calling test because services code cannot import DB
 * schema/helpers directly (`no-restricted-imports` on
 * `apps/web/src/server/services/**`).
 */
export async function seedEntityEmbedding(
  db: Database | DrizzleTransaction,
  input: SearchableEntityText & {
    config: SemanticEmbeddingConfig;
  },
): Promise<void> {
  const embeddingHash = await embeddingTextHash({
    entityType: input.entityType,
    provider: input.config.provider,
    model: input.config.model,
    dimensions: input.config.dimensions,
    text: normalizeSearchText(input.embeddingText),
  });

  await upsertEntityEmbeddingsIfCurrent(db, [
    {
      entityType: input.entityType,
      entityId: input.entityId,
      embeddingText: input.embeddingText,
      embeddingHash,
      config: input.config,
    },
  ]);
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
      extras: {
        category: sql<
          string | null
        >`${categorySummarySql(sql`${product.categoryId}`)}->>'name'`.as(
          "category",
        ),
      },
      columns: {
        id: true,
        name: true,
        manufacturer: true,
        categoryId: true,
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

/** Image analysis/corrections are appended by the shared search projection. */
async function getImageEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(image),
        options.ids?.length
          ? inArray(
              image.id,
              options.ids.map((id) => parseEntityId("image", id)),
            )
          : undefined,
      ),
      columns: { id: true, filename: true },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.image.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "image",
    entityId: row.id,
    embeddingText: row.filename,
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
      category: sql<
        string | null
      >`${categorySummarySql(sql`${product.categoryId}`)}->>'name'`,
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
      extras: {
        resolvedLocations: effectiveProjectLocationsSql(sql`"project"."id"`).as(
          "resolvedLocations",
        ),
      },
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
    embeddingText: buildProjectEmbeddingText({
      ...row,
      locations: row.resolvedLocations,
    }),
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
      trade: effectiveTaskTradeSql(),
      projectName: project.name,
      subjectProductName: product.name,
    })
    .from(task)
    .leftJoin(project, eq(effectiveTaskProjectSql(), project.id))
    .leftJoin(product, eq(effectiveTaskSubjectProductSql(), product.id))
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
      trade: effectiveExpenseTradeSql(),
      notes: expense.notes,
      projectName: expenseProjectNamesSql(sql`${expense.id}`),
      vendorName: vendor.name,
      orderId: purchase.orderId,
    })
    .from(expense)
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

const identityTerms = (
  identity: FinancialAccountIdentity,
  cardNumbers: FinancialAccountCardNumber[],
): string[] => {
  const last4s = cardNumbers.map((card) => card.last4);
  switch (identity.kind) {
    case "credit_card":
      return presentIdentityTerms([
        identity.kind,
        identity.issuer,
        identity.network,
        ...last4s,
      ]);
    case "bank_account":
      return presentIdentityTerms([
        identity.kind,
        identity.institution,
        identity.accountType,
        ...last4s,
      ]);
    case "stored_value":
      return presentIdentityTerms([
        identity.kind,
        identity.provider,
        ...last4s,
      ]);
    case "cash":
      return [identity.kind];
    case "other":
      return presentIdentityTerms([
        identity.kind,
        identity.institution,
        ...last4s,
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
        cardNumbers: true,
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
      identityTerms: identityTerms(row.identity, row.cardNumbers),
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

async function getPlantEmbeddingTexts(
  db: Database | DrizzleTransaction,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const queryConfig = withOptionalLimit(
    {
      where: and(
        notDeleted(plant),
        options.ids?.length
          ? inArray(
              plant.id,
              options.ids.map((id) => parseEntityId("plant", id)),
            )
          : undefined,
      ),
      columns: {
        id: true,
        name: true,
        gardenGuideKey: true,
        latinName: true,
        verdict: true,
        notes: true,
      },
    },
    options.limit,
  );
  const rows = await unwrapDb(db).query.plant.findMany(queryConfig);
  return rows.map((row) => ({
    entityType: "plant",
    entityId: row.id,
    embeddingText: buildPlantEmbeddingText({
      displayName: plantDisplayName(row.name, row.gardenGuideKey),
      latinName: row.latinName,
      verdict: row.verdict,
      notes: row.notes,
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
      columns: { id: true, status: true, notes: true },
      with: {
        plant: { columns: { name: true, gardenGuideKey: true } },
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
      plantName: plantingDisplayName(row.plant),
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
        plantings: {
          where: notDeleted(gardenEntryPlanting),
          with: {
            planting: {
              columns: { id: true },
              with: {
                plant: { columns: { name: true, gardenGuideKey: true } },
              },
            },
          },
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
      plantingName:
        row.plantings
          .flatMap((link) =>
            link.planting ? [plantingDisplayName(link.planting.plant)] : [],
          )
          .join(", ") || null,
      note: row.note,
      harvestAmount: row.harvestAmount,
    }),
  }));
}

const embeddingTextLoaders = {
  image: getImageEmbeddingTexts,
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
  plant: getPlantEmbeddingTexts,
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
