import type {
  AiAnalysisEntityType,
  AiAnalysisRuntime,
} from "@cubby/schemas/ai";
import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Amount } from "@cubby/schemas/codec";
import type { Entity } from "@cubby/schemas/entity-core";
import type {
  ExpenseAttributionId,
  ExpenseId,
  FinancialAccountId,
  FinancialTransactionId,
  GardenEntryId,
  IngredientId,
  LedgerPartyId,
  LedgerTransferId,
  LocationId,
  MealId,
  MealFoodEntryId,
  MealRecipeId,
  MealRecipePortionId,
  PlantingId,
  ProductId,
  ProjectId,
  PurchaseId,
  RecipeId,
  TaskId,
  UserId,
  VendorId,
  WishId,
} from "@cubby/schemas/identifiers";
import type { ContributionRole } from "@cubby/schemas/ledger-party";
import type { LedgerSourceClaimNormalizedEvidence } from "@cubby/schemas/ledger-transfer";
import type { MealFoodAmount, MealFoodNutrients } from "@cubby/schemas/meal";
import {
  type PurchaseDocumentKind,
  purchaseDocumentKindValues,
} from "@cubby/schemas/purchase";
import type { SearchableEntity } from "@cubby/schemas/search";
import type {
  McpToolCallOutcome,
  McpToolCallSurface,
} from "@cubby/schemas/telemetry";
import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  account,
  apikey,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  passkey,
  session,
  user,
  verification,
} from "./auth.schema";
import {
  generatedCookbookColumns,
  generatedExpenseColumns,
  generatedFinancialAccountColumns,
  generatedFinancialTransactionColumns,
  generatedImageColumns,
  generatedIngredientColumns,
  generatedInventoryColumns,
  generatedLedgerPartyColumns,
  generatedLedgerTransferColumns,
  generatedLocationColumns,
  generatedMealColumns,
  generatedProductColumns,
  generatedPlantingColumns,
  generatedGardenEntryColumns,
  generatedProjectColumns,
  generatedPurchaseColumns,
  generatedRecipeColumns,
  generatedTaskColumns,
  generatedVendorColumns,
  generatedVendorAccountColumns,
  generatedWishColumns,
  imageRenderStatusEnum,
  imageStatusEnum,
  imageStorageStatusEnum,
  inventoryPlacementEnum,
  recipeSourceEnum,
} from "./generated/entity-columns.gen";
import { productCategory } from "./product-category-schema";

export {
  recipeSourceEnum,
  imageStatusEnum,
  inventoryPlacementEnum,
  imageRenderStatusEnum,
  imageStorageStatusEnum,
};

export type { Amount };
export type Instruction = { text: string };

// `tsvector` is maintained by the search-document projection, rather than a
// generated column, because each document has field-specific weights.
const pgTsVector = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "tsvector";
  },
});

export {
  account,
  apikey,
  jwks,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthClientResource,
  oauthConsent,
  oauthRefreshToken,
  oauthResource,
  passkey,
  session,
  user,
  verification,
};

const baseTimestamps = () => ({
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
const softDeletedAt = () => ({
  deletedAt: timestamp("deletedAt", { mode: "date" }),
});
const pkUuid = <T extends string = string>() =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .$type<T>();

/**
 * The entity's public id (`PRD-4K7M`) — what URLs, QR labels, and MCP expose.
 * The uuid PK above stays private to repositories and in-process workflows.
 *
 * Deliberately NOT branded: the Product/Ingredient/Image spike showed that
 * generic Drizzle table unions erase the entity correlation on inserts and
 * comparisons. Repository mapper seams validate stored strings through the
 * entity-specific shortcode schemas instead.
 */
/**
 * Uniqueness over the WHOLE table, soft-deleted rows included. That is the
 * point: a code must never be reused, so a deleted row's code stays a permanent
 * tombstone rather than becoming available again. A partial index on
 * `deletedAt IS NULL` would let a deleted row's code be handed to a second
 * entity.
 */
const shortcodeUnique = (tableName: string, column: AnyPgColumn) =>
  uniqueIndex(`${tableName}_shortcode_unique`).on(column);

/** Exact scalar meal amount shape shared by food entries and served portions. */
const validMealFoodAmount = (column: AnyPgColumn) => sql`
  ${column} IS NULL OR COALESCE((
    jsonb_typeof(${column}) = 'object'
    AND ${column} ? 'value'
    AND ${column} ? 'unit'
    AND ${column} - 'value' - 'unit' = '{}'::jsonb
    AND CASE
      WHEN jsonb_typeof(${column}->'value') = 'number' THEN
        (${column}->>'value')::numeric > 0
        AND (${column}->>'value')::numeric < 'Infinity'::numeric
      ELSE false
    END
    AND jsonb_typeof(${column}->'unit') = 'string'
    AND length(trim(${column}->>'unit')) > 0
    AND ${column}->>'unit' = trim(${column}->>'unit')
  ), false)
`;

export const recipe = pgTable(
  "Recipe",
  generatedRecipeColumns({
    cookbook: (): AnyPgColumn => cookbook.id,
    recipe: (): AnyPgColumn => recipe.id,
  }),
  (table) => [
    shortcodeUnique("Recipe", table.shortcode),
    // Non-cookbook recipes keep a globally-unique name. EPUB-imported (Book) and
    // Notion-synced recipes are excluded here — they're keyed by (name, book) and
    // by Notion page id respectively — so the same title can appear across a
    // cookbook, a Notion page, and a web recipe. `IS DISTINCT FROM` (not NOT IN)
    // keeps NULL-SourceType legacy rows inside the index.
    uniqueIndex("Recipe_name_key")
      .on(table.name)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.SourceType} IS DISTINCT FROM 'Book' AND ${table.SourceType} IS DISTINCT FROM 'Notion'`,
      ),
    // A cookbook recipe's identity is (cookbook, title): unique per book, but the
    // same title may recur across books. The upsert keys on `cookbookId`; this DB
    // guard uses `SourceData` (kept synced to the cookbook name, which is itself
    // unique) so it's equivalent and needs no nullable-FK partial index.
    uniqueIndex("Recipe_book_title_key")
      .on(table.name, table.SourceData)
      .where(sql`${table.deletedAt} IS NULL AND ${table.SourceType} = 'Book'`),
    // A Notion-synced recipe's identity is its Notion page id, stored in
    // SourceData. This makes re-importing a page idempotent (and a renamed page
    // still hits the same row) — the analogue of bookTitleUnique for Notion.
    uniqueIndex("Recipe_notion_page_key")
      .on(table.SourceData)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.SourceType} = 'Notion'`,
      ),
    index("Recipe_SourceType_idx").on(table.SourceType),
    index("Recipe_cookbookId_idx").on(table.cookbookId),
    index("Recipe_forkedFromRecipeId_idx").on(table.forkedFromRecipeId),
    index("Recipe_created_at_desc_idx").on(table.createdAt.desc()),
    index("Recipe_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Recipe_totals_stale_idx")
      .on(table.totalsComputedAt)
      .where(sql`${table.totalsComputedAt} IS NULL`),
  ],
);

// Cookbook table — a first-class recipe source (the book a set of EPUB-extracted
// recipes came from). Holds the full assembled `ImportRecipe[]` JSON so recipes
// can be re-derived without re-running the LLM, plus OPF metadata. A cookbook is
// always born from a full import, so every content column is NOT NULL.
// `productId` links the digital source to the physical book on the shelf. This
// was deliberately absent until 2026-08: the EPUB set and the shelf genuinely
// didn't overlap when Cookbook was introduced, but the Amazon backfill landed
// ~50 cookbooks as Products and the populations now intersect. Matching is
// always human-confirmed — never auto-link on a title prefix, because
// "Tartine Book No. 3" and "Tartine: A Classic Revisited" are different books.
export const cookbook = pgTable(
  "Cookbook",
  generatedCookbookColumns({
    image: (): AnyPgColumn => image.id,
    product: (): AnyPgColumn => product.id,
  }),
  (table) => [
    shortcodeUnique("Cookbook", table.shortcode),
    uniqueIndex("Cookbook_name_key")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Cookbook_createdAt_idx").on(table.createdAt),
    index("Cookbook_coverImageId_idx").on(table.coverImageId),
    index("Cookbook_productId_idx").on(table.productId),
    index("Cookbook_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
  ],
);

export const recipeSection = pgTable(
  "RecipeSection",
  {
    id: pkUuid(),
    recipeId: uuid("recipeId")
      .notNull()
      .$type<RecipeId>()
      .references(() => recipe.id),
    name: text("name"),
    ...baseTimestamps(),
    ...softDeletedAt(),
    instructions: jsonb("instructions")
      .notNull()
      .$type<Instruction[]>()
      .default(sql`'[]'::jsonb`),
    // Position within the recipe. Nullable: rows saved before this column was
    // added have no recoverable order (createdAt is the transaction timestamp,
    // identical across one save) — reads tiebreak on createdAt/id for those.
    sortOrder: integer("sortOrder"),
  },
  (table) => [
    index("RecipeSection_recipeId_idx").on(table.recipeId),
    index("RecipeSection_createdAt_idx").on(table.createdAt),
  ],
);

export const ingredient = pgTable(
  "Ingredient",
  generatedIngredientColumns({ recipe: (): AnyPgColumn => recipe.id }),
  (table) => [
    shortcodeUnique("Ingredient", table.shortcode),
    // Case-insensitive uniqueness must match the lower(name) matcher to prevent concurrent duplicate ingredients.
    uniqueIndex("Ingredient_name_key")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL AND ${table.recipeId} IS NULL`),
    uniqueIndex("Ingredient_recipeId_key")
      .on(table.recipeId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Ingredient_recipeId_idx").on(table.recipeId),
    index("Ingredient_createdAt_idx").on(table.createdAt),
    index("Ingredient_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    index("Ingredient_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const recipeSectionIngredient = pgTable(
  "RecipeSectionIngredient",
  {
    id: pkUuid(),
    recipeSectionId: uuid("recipeSectionId")
      .notNull()
      .references(() => recipeSection.id),
    ingredientId: uuid("ingredientId")
      .notNull()
      .$type<IngredientId>()
      .references(() => ingredient.id),
    amounts: jsonb("amounts")
      .notNull()
      .$type<Amount[]>()
      .default(sql`'[]'::jsonb`),
    // Raw, unparsed ingredient line as it arrived from the scraper/cookbook
    // import, plus the parser-derived modifier (e.g. "finely chopped") that is
    // otherwise discarded. Retained so a future parser upgrade can be re-applied
    // to existing rows without re-importing the source. Nullable: only populated
    // for rows created after this column was added.
    rawLine: text("rawLine"),
    modifier: text("modifier"),
    sortOrder: integer("sortOrder"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("RecipeSectionIngredient_recipeSectionId_idx").on(
      table.recipeSectionId,
    ),
    index("RecipeSectionIngredient_ingredientId_idx").on(table.ingredientId),
  ],
);

export const meal = pgTable("Meal", generatedMealColumns(), (table) => [
  shortcodeUnique("Meal", table.shortcode),
  index("Meal_date_active_idx")
    .on(table.date)
    .where(sql`${table.deletedAt} IS NULL`),
]);

export const mealRecipe = pgTable(
  "MealRecipe",
  {
    id: pkUuid<MealRecipeId>(),
    mealId: uuid("mealId")
      .notNull()
      .$type<MealId>()
      .references(() => meal.id),
    recipeId: uuid("recipeId")
      .notNull()
      .$type<RecipeId>()
      .references(() => recipe.id),
    scale: real("scale").notNull().default(1),
    sortOrder: integer("sortOrder"),
    estimatedYieldGrams: integer("estimatedYieldGrams"),
    actualYieldGrams: integer("actualYieldGrams"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("MealRecipe_mealId_idx").on(table.mealId),
    index("MealRecipe_recipeId_idx").on(table.recipeId),
    check(
      "MealRecipe_estimatedYieldGrams_check",
      sql`${table.estimatedYieldGrams} IS NULL OR ${table.estimatedYieldGrams} > 0`,
    ),
    check(
      "MealRecipe_actualYieldGrams_check",
      sql`${table.actualYieldGrams} IS NULL OR ${table.actualYieldGrams} > 0`,
    ),
  ],
);

export const mealRecipePortion = pgTable(
  "MealRecipePortion",
  {
    id: pkUuid<MealRecipePortionId>(),
    mealRecipeId: uuid("mealRecipeId")
      .notNull()
      .$type<MealRecipeId>()
      .references(() => mealRecipe.id, { onDelete: "cascade" }),
    mealId: uuid("mealId")
      .notNull()
      .$type<MealId>()
      .references(() => meal.id),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    amount: jsonb("amount").$type<MealFoodAmount>(),
    // Expand-migration compatibility only. New writes use `amount`.
    grams: integer("grams"),
    confirmedAt: timestamp("confirmedAt", { mode: "date" }),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("MealRecipePortion_live_source_target_eater_key")
      .on(table.mealRecipeId, table.mealId, table.ledgerPartyId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("MealRecipePortion_mealRecipeId_idx").on(table.mealRecipeId),
    index("MealRecipePortion_mealId_idx").on(table.mealId),
    index("MealRecipePortion_ledgerPartyId_idx").on(table.ledgerPartyId),
    check(
      "MealRecipePortion_grams_check",
      sql`${table.grams} IS NULL OR ${table.grams} > 0`,
    ),
    check("MealRecipePortion_amount_check", validMealFoodAmount(table.amount)),
    check(
      "MealRecipePortion_amount_source_check",
      sql`(${table.amount} IS NULL) <> (${table.grams} IS NULL)`,
    ),
  ],
);

export const mealFoodEntry = pgTable(
  "MealFoodEntry",
  {
    id: pkUuid<MealFoodEntryId>(),
    mealId: uuid("mealId")
      .notNull()
      .$type<MealId>()
      .references((): AnyPgColumn => meal.id),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references((): AnyPgColumn => ledgerParty.id),
    sourceKind: text("sourceKind")
      .notNull()
      .$type<"ingredient" | "product" | "manual">(),
    ingredientId: uuid("ingredientId")
      .$type<IngredientId>()
      .references((): AnyPgColumn => ingredient.id),
    productId: uuid("productId")
      .$type<ProductId>()
      .references((): AnyPgColumn => product.id),
    amount: jsonb("amount").$type<MealFoodAmount>(),
    // Expand-migration compatibility only. New writes use `amount`.
    grams: doublePrecision("grams"),
    name: text("name"),
    nutrients: jsonb("nutrients").$type<MealFoodNutrients>(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("MealFoodEntry_mealId_idx").on(table.mealId),
    index("MealFoodEntry_ledgerPartyId_idx").on(table.ledgerPartyId),
    index("MealFoodEntry_ingredientId_idx").on(table.ingredientId),
    index("MealFoodEntry_productId_idx").on(table.productId),
    check(
      "MealFoodEntry_grams_check",
      sql`${table.grams} IS NULL OR (${table.grams} > 0 AND ${table.grams} < 'Infinity'::float8)`,
    ),
    check("MealFoodEntry_amount_check", validMealFoodAmount(table.amount)),
    check(
      "MealFoodEntry_amount_compatibility_check",
      sql`${table.amount} IS NULL OR ${table.grams} IS NULL`,
    ),
    check(
      "MealFoodEntry_source_check",
      sql`(${table.sourceKind} = 'ingredient' AND ${table.ingredientId} IS NOT NULL AND ${table.productId} IS NULL AND (${table.amount} IS NOT NULL OR ${table.grams} IS NOT NULL) AND ${table.name} IS NULL AND ${table.nutrients} IS NULL) OR (${table.sourceKind} = 'product' AND ${table.ingredientId} IS NULL AND ${table.productId} IS NOT NULL AND (${table.amount} IS NOT NULL OR ${table.grams} IS NOT NULL) AND ${table.name} IS NULL AND ${table.nutrients} IS NULL) OR (${table.sourceKind} = 'manual' AND ${table.ingredientId} IS NULL AND ${table.productId} IS NULL AND length(trim(${table.name})) > 0 AND ${table.name} IS NOT NULL AND ${table.nutrients} IS NOT NULL AND jsonb_typeof(${table.nutrients}) = 'object' AND ${table.nutrients} <> '{}'::jsonb)`,
    ),
  ],
);

export { productCategory } from "./product-category-schema";

export const product = pgTable(
  "Product",
  generatedProductColumns({
    ingredient: (): AnyPgColumn => ingredient.id,
    productCategory: (): AnyPgColumn => productCategory.id,
  }),
  (table) => [
    shortcodeUnique("Product", table.shortcode),
    index("Product_categoryId_idx").on(table.categoryId),
    uniqueIndex("Product_name_manufacturer_key")
      .on(table.name, table.manufacturer)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Product_ingredientId_idx").on(table.ingredientId),
    index("Product_createdAt_idx").on(table.createdAt),
    index("Product_name_idx").on(table.name),
    index("Product_name_gin_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    // No GIN on `aliases` (here, Ingredient, or Location): every alias filter
    // is `unnest(aliases) ILIKE`, which an array GIN cannot serve — those
    // index @>/&&/= ANY. EXPLAIN confirms a seq scan with a per-row SubPlan
    // either way, so the index was pure write cost.
    index("Product_manufacturer_gin_idx").using(
      "gin",
      sql`${table.manufacturer} gin_trgm_ops`,
    ),
    index("Product_name_manufacturer_idx").on(table.name, table.manufacturer),
    index("Product_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Product_manufacturer_active_idx")
      .on(table.manufacturer)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const productExternalId = pgTable(
  "ProductExternalId",
  {
    id: pkUuid(),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    source: text("source").notNull(), // e.g. "amazon", "mcmaster", "mouser"
    kind: text("kind").notNull().default("legacy_unspecified"),
    externalId: text("externalId").notNull(), // The actual identifier (ASIN, part number, etc.)
    url: text("url"), // Optional direct link to the product page
    /**
     * The value that stands for the slot. One per (productId, source, kind);
     * secondaries are unlimited.
     *
     * A slot used to hold exactly one row, so merging two products that each
     * carried an ASIN destroyed one of them — and each discarded ASIN is a real
     * listing, so the next order line quoting it re-mints the duplicate the
     * merge just removed.
     */
    isPrimary: boolean("isPrimary").notNull().default(true),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("ProductExternalId_productId_idx").on(table.productId),
    // One PRIMARY per slot rather than one row per slot.
    //
    // This replaced `ProductExternalId_product_source_kind_key`, and the swap
    // had to straddle the deploy: the two code versions infer DIFFERENT arbiter
    // indexes for the same upsert (`WHERE deletedAt IS NULL` before,
    // `WHERE isPrimary AND deletedAt IS NULL` after), so both had to exist at
    // once. Applied by hand for that reason, not because push cannot express it.
    uniqueIndex("ProductExternalId_product_source_kind_primary_key")
      .on(table.productId, table.source, table.kind)
      .where(sql`${table.isPrimary} AND ${table.deletedAt} IS NULL`),
    // Stays GLOBAL and unconditional: this is the constraint that makes
    // `find_product_external_id_collisions` work at all, by guaranteeing an
    // identifier has at most one live owner.
    uniqueIndex("ProductExternalId_source_kind_externalId_key")
      .on(table.source, table.kind, table.externalId)
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      "ProductExternalId_source_slug_check",
      sql`${table.source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${table.source} = lower(trim(${table.source}))`,
    ),
    // Barcodes are stored in ONE canonical encoding (GTIN-14, zero-padded), so
    // that the global `(source, kind, externalId)` unique above is what stops
    // two live products claiming one barcode. Storing the encoding as scanned
    // would put a 12-digit UPC-A and its 13-digit reprint in two different
    // strings, and the unique would let both through — which is exactly the bug
    // the partial `Product_upc_key` had.
    //
    // A constraint rather than a Zod convention because the normalization is a
    // `lpad(..., 14, '0')` on the SQL side, and lpad TRUNCATES input longer
    // than 14 instead of erroring.
    check(
      "ProductExternalId_gtin_digits_check",
      sql`${table.source} <> 'gtin' OR ${table.externalId} ~ '^[0-9]{14}$'`,
    ),
  ],
);

export const productUnitMappings = pgTable(
  "ProductUnitMappings",
  {
    id: pkUuid(),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    a: jsonb("a").notNull().$type<Amount>(),
    b: jsonb("b").notNull().$type<Amount>(),
    source: text("source"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [index("ProductUnitMappings_productId_idx").on(table.productId)],
);

/**
 * Rebuildable conversion-coverage projection. The conversion engine remains
 * WASM; this table only makes its catalog-wide result filterable/sortable
 * without evaluating a graph for a paginated list page.
 */
export const productConversionCoverage = pgTable(
  "ProductConversionCoverage",
  {
    productId: uuid("productId")
      .primaryKey()
      .$type<ProductId>()
      .references(() => product.id, { onDelete: "cascade" }),
    coverageTier: text("coverageTier").notNull(),
    coveredKinds: text("coveredKinds")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    applicableKinds: text("applicableKinds")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    islandCount: integer("islandCount").notNull().default(0),
    // A mutation marks the row stale until the shared conversion engine has
    // rebuilt it. Query filters intentionally only read ready rows.
    status: text("status").notNull().default("ready"),
    engineVersion: text("engineVersion").notNull(),
    computedAt: timestamp("computedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("ProductConversionCoverage_tier_idx").on(table.coverageTier),
    index("ProductConversionCoverage_island_idx").on(table.islandCount),
    index("ProductConversionCoverage_status_idx").on(table.status),
  ],
);

/**
 * Materialized UPC-provider answers, keyed by the stable barcode rather than a
 * Product. A product can gain or lose an empty field without invalidating the
 * provider's answer; proposal membership is re-evaluated from this cache.
 *
 * `status=ready` includes a provider miss: it is a successfully checked UPC
 * with no useful fields, not an outage. Provider outages deliberately do not
 * overwrite a previous answer, so callers can distinguish stale data from an
 * unavailable provider.
 */
export const upcLookupCache = pgTable(
  "UpcLookupCache",
  {
    upc: text("upc").primaryKey(),
    manufacturer: text("manufacturer"),
    brand: text("brand"),
    priceDollars: doublePrecision("priceDollars"),
    imageUrl: text("imageUrl"),
    status: text("status").notNull().default("ready"),
    fetchedAt: timestamp("fetchedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("UpcLookupCache_fetchedAt_idx").on(table.fetchedAt),
    index("UpcLookupCache_status_idx").on(table.status),
  ],
);

export const location = pgTable(
  "Location",
  generatedLocationColumns({
    location: (): AnyPgColumn => location.id,
    product: (): AnyPgColumn => product.id,
  }),
  (table) => [
    shortcodeUnique("Location", table.shortcode),
    uniqueIndex("Location_name_key")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Location_name_idx").on(table.name),
    index("Location_tags_idx").using("gin", table.tags),
    index("Location_type_idx").on(table.type),
    index("Location_productId_idx").on(table.productId),
    index("Location_parentId_idx").on(table.parentId),
    index("Location_createdAt_idx").on(table.createdAt),
    index("Location_lastBulkInventory_idx").on(table.lastBulkInventory),
    index("Location_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    index("Location_type_name_idx").on(table.type, table.name),
    index("Location_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Location_type_active_idx")
      .on(table.type)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const entityEmbedding = pgTable(
  "EntityEmbedding",
  {
    id: pkUuid(),
    entityType: text("entityType").notNull().$type<SearchableEntity>(),
    entityId: uuid("entityId").notNull(),
    embeddingText: text("embeddingText").notNull(),
    embeddingHash: text("embeddingHash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("EntityEmbedding_entity_model_key")
      .on(
        table.entityType,
        table.entityId,
        table.provider,
        table.model,
        table.dimensions,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("EntityEmbedding_entity_idx").on(table.entityType, table.entityId),
    index("EntityEmbedding_model_idx").on(
      table.provider,
      table.model,
      table.dimensions,
    ),
  ],
);

/**
 * Rebuildable, denormalized search projection. It is deliberately not an
 * authority for entity data: mutation side-effects refresh rows from the
 * source tables, and a full backfill can recreate it at any time.
 */
export const searchDocument = pgTable(
  "SearchDocument",
  {
    id: pkUuid(),
    entityType: text("entityType").notNull().$type<SearchableEntity>(),
    entityId: uuid("entityId").notNull(),
    shortcode: text("shortcode").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    typeHint: text("typeHint"),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    body: text("body").notNull(),
    semanticText: text("semanticText").notNull(),
    normalizedText: text("normalizedText").notNull(),
    searchVector: pgTsVector("searchVector").notNull(),
    sourceHash: text("sourceHash").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("SearchDocument_live_entity_key")
      .on(table.entityType, table.entityId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("SearchDocument_shortcode_active_idx")
      .using("btree", sql`lower(${table.shortcode})`)
      .where(sql`${table.deletedAt} IS NULL`),
    index("SearchDocument_title_active_idx")
      .using("btree", sql`lower(${table.title}) text_pattern_ops`)
      .where(sql`${table.deletedAt} IS NULL`),
    index("SearchDocument_vector_gin_idx")
      .using("gin", table.searchVector)
      .where(sql`${table.deletedAt} IS NULL`),
    index("SearchDocument_normalized_gist_idx")
      .using("gist", sql`${table.normalizedText} gist_trgm_ops`)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const suggestionDismissal = pgTable(
  "SuggestionDismissal",
  {
    id: pkUuid(),
    sourceEntityType: text("sourceEntityType")
      .notNull()
      .$type<SearchableEntity>(),
    sourceEntityId: uuid("sourceEntityId").notNull(),
    suggestionKind: text("suggestionKind").notNull(),
    candidateKey: text("candidateKey").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("SuggestionDismissal_active_key")
      .on(
        table.sourceEntityType,
        table.sourceEntityId,
        table.suggestionKind,
        table.candidateKey,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("SuggestionDismissal_source_idx").on(
      table.sourceEntityType,
      table.sourceEntityId,
    ),
  ],
);

export const inventoryEntry = pgTable(
  "InventoryEntry",
  generatedInventoryColumns({
    ledgerParty: (): AnyPgColumn => ledgerParty.id,
    product: (): AnyPgColumn => product.id,
    location: (): AnyPgColumn => location.id,
  }),
  (table) => [
    shortcodeUnique("InventoryEntry", table.shortcode),
    // Placement is part of the key so a spare on the shelf and one wired into
    // the wall can coexist in the same room — the normal state, not a duplicate.
    // Strictly more permissive than the old two-column form, so the CREATE can
    // never fail on existing data.
    uniqueIndex("InventoryEntry_productId_locationId_key")
      .on(
        table.productId,
        table.locationId,
        table.placement,
        table.ownershipMode,
        sql`coalesce(${table.ownerLedgerPartyId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    check(
      "InventoryEntry_ownership_valid",
      sql`(${table.ownershipMode} = 'person' AND ${table.ownerLedgerPartyId} IS NOT NULL) OR (${table.ownershipMode} IN ('inherit', 'unassigned') AND ${table.ownerLedgerPartyId} IS NULL)`,
    ),
    index("InventoryEntry_owner_idx").on(table.ownerLedgerPartyId),
    index("InventoryEntry_productId_idx").on(table.productId),
    index("InventoryEntry_locationId_idx").on(table.locationId),
    index("InventoryEntry_createdAt_idx").on(table.createdAt),
  ],
);

export const image = pgTable("Image", generatedImageColumns(), (table) => [
  shortcodeUnique("Image", table.shortcode),
  check(
    "Image_perceptualHash_format_check",
    sql`${table.perceptualHash} IS NULL OR ${table.perceptualHash} ~ '^[0-9a-f]{16}$'`,
  ),
  uniqueIndex("Image_key_key")
    .on(table.key)
    .where(sql`${table.deletedAt} IS NULL`),
  index("Image_createdAt_idx").on(table.createdAt),
  index("Image_status_idx").on(table.status),
  uniqueIndex("Image_attachment_idempotency_key")
    .on(table.targetType, table.targetId, table.idempotencyKey)
    .where(
      sql`${table.idempotencyKey} IS NOT NULL AND ${table.deletedAt} IS NULL`,
    ),
]);

export const productImage = pgTable(
  "ProductImage",
  {
    id: pkUuid(),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    // Display order; 0 default means legacy rows tie-break on createdAt.
    sortOrder: integer("sortOrder").notNull().default(0),
    // `null` is the legacy item role and deliberately remains displayable.
    purpose: text("purpose", { enum: ["item", "label"] as const }),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ProductImage_productId_imageId_key")
      .on(table.productId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ProductImage_productId_idx").on(table.productId),
    index("ProductImage_imageId_idx").on(table.imageId),
    check(
      "ProductImage_purpose_check",
      sql`${table.purpose} IS NULL OR ${table.purpose} IN ('item', 'label')`,
    ),
  ],
);

export const locationImage = pgTable(
  "LocationImage",
  {
    id: pkUuid(),
    locationId: uuid("locationId")
      .notNull()
      .$type<LocationId>()
      .references(() => location.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("LocationImage_locationId_imageId_key")
      .on(table.locationId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("LocationImage_locationId_idx").on(table.locationId),
    index("LocationImage_imageId_idx").on(table.imageId),
  ],
);

export const planting = pgTable(
  "Planting",
  generatedPlantingColumns({
    ingredient: (): AnyPgColumn => ingredient.id,
    product: (): AnyPgColumn => product.id,
    location: (): AnyPgColumn => location.id,
    task: (): AnyPgColumn => task.id,
  }),
  (table) => [
    shortcodeUnique("Planting", table.shortcode),
    index("Planting_ingredientId_idx").on(table.ingredientId),
    index("Planting_sourceProductId_idx").on(table.sourceProductId),
    index("Planting_locationId_idx").on(table.locationId),
    index("Planting_taskId_idx").on(table.taskId),
    index("Planting_status_idx").on(table.status),
  ],
);

export const gardenEntry = pgTable(
  "GardenEntry",
  generatedGardenEntryColumns({
    location: (): AnyPgColumn => location.id,
  }),
  (table) => [
    shortcodeUnique("GardenEntry", table.shortcode),
    index("GardenEntry_locationId_idx").on(table.locationId),
    index("GardenEntry_observedOn_idx").on(table.observedOn),
  ],
);

/**
 * A garden observation may describe more than one growing attempt.  The
 * association is historical in its own right, so removal detaches it without
 * deleting either the dated entry or the planting.  The partial pair key is
 * what permits a removed planting to be re-attached later without resurrecting
 * an unrelated live duplicate.
 */
export const gardenEntryPlanting = pgTable(
  "GardenEntryPlanting",
  {
    id: pkUuid(),
    gardenEntryId: uuid("gardenEntryId")
      .notNull()
      .$type<GardenEntryId>()
      .references(() => gardenEntry.id),
    plantingId: uuid("plantingId")
      .notNull()
      .$type<PlantingId>()
      .references(() => planting.id),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("GardenEntryPlanting_gardenEntryId_plantingId_key")
      .on(table.gardenEntryId, table.plantingId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("GardenEntryPlanting_gardenEntryId_idx").on(table.gardenEntryId),
    index("GardenEntryPlanting_plantingId_idx").on(table.plantingId),
  ],
);

export const gardenEntryImage = pgTable(
  "GardenEntryImage",
  {
    id: pkUuid(),
    gardenEntryId: uuid("gardenEntryId")
      .notNull()
      .references(() => gardenEntry.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("GardenEntryImage_gardenEntryId_imageId_key")
      .on(table.gardenEntryId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("GardenEntryImage_gardenEntryId_idx").on(table.gardenEntryId),
    index("GardenEntryImage_imageId_idx").on(table.imageId),
  ],
);

export const recipeImage = pgTable(
  "RecipeImage",
  {
    id: pkUuid(),
    recipeId: uuid("recipeId")
      .notNull()
      .$type<RecipeId>()
      .references(() => recipe.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("RecipeImage_recipeId_imageId_key")
      .on(table.recipeId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("RecipeImage_recipeId_idx").on(table.recipeId),
    index("RecipeImage_imageId_idx").on(table.imageId),
  ],
);

export const mealImage = pgTable(
  "MealImage",
  {
    id: pkUuid(),
    mealId: uuid("mealId")
      .notNull()
      .$type<MealId>()
      .references(() => meal.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("MealImage_mealId_imageId_key")
      .on(table.mealId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("MealImage_mealId_idx").on(table.mealId),
    index("MealImage_imageId_idx").on(table.imageId),
  ],
);

export const taskImage = pgTable(
  "TaskImage",
  {
    id: pkUuid(),
    taskId: uuid("taskId")
      .notNull()
      .$type<TaskId>()
      .references(() => task.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("TaskImage_taskId_imageId_key")
      .on(table.taskId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("TaskImage_taskId_idx").on(table.taskId),
    index("TaskImage_imageId_idx").on(table.imageId),
  ],
);

export const project = pgTable(
  "Project",
  generatedProjectColumns({ project: (): AnyPgColumn => project.id }),
  (table) => [
    shortcodeUnique("Project", table.shortcode),
    uniqueIndex("Project_notionPageId_key")
      .on(table.notionPageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Project_status_idx").on(table.status),
    index("Project_kind_idx").on(table.kind),
    index("Project_startDate_idx").on(table.startDate),
    index("Project_parentProjectId_idx").on(table.parentProjectId),
    index("Project_name_gin_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    index("Project_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const projectDependency = pgTable(
  "ProjectDependency",
  {
    id: pkUuid(),
    projectId: uuid("projectId")
      .notNull()
      .$type<ProjectId>()
      .references(() => project.id),
    blockedByProjectId: uuid("blockedByProjectId")
      .notNull()
      .$type<ProjectId>()
      .references(() => project.id),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ProjectDependency_pair_key").on(
      table.projectId,
      table.blockedByProjectId,
    ),
    index("ProjectDependency_blockedBy_idx").on(table.blockedByProjectId),
    check(
      "ProjectDependency_no_self_check",
      sql`${table.projectId} <> ${table.blockedByProjectId}`,
    ),
  ],
);

// Durable, deliberately coarse history that a reusable tool or software Product
// was used on a Project. One live pair is one project-use; no quantities/hours/
// trades live here because those would turn the relation into a usage ledger.
export const projectToolUsage = pgTable(
  "ProjectToolUsage",
  {
    id: pkUuid(),
    projectId: uuid("projectId")
      .notNull()
      .$type<ProjectId>()
      .references(() => project.id),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ProjectToolUsage_projectId_productId_key")
      .on(table.projectId, table.productId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ProjectToolUsage_projectId_idx").on(table.projectId),
    index("ProjectToolUsage_productId_idx").on(table.productId),
  ],
);

export const wish = pgTable("Wish", generatedWishColumns(), (table) => [
  shortcodeUnique("Wish", table.shortcode),
  index("Wish_createdAt_idx").on(table.createdAt),
  index("Wish_acquiredAt_idx").on(table.acquiredAt),
]);

export const wishCandidate = pgTable(
  "WishCandidate",
  {
    id: pkUuid(),
    wishId: uuid("wishId")
      .notNull()
      .$type<WishId>()
      .references(() => wish.id),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("WishCandidate_wishId_productId_key")
      .on(table.wishId, table.productId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("WishCandidate_wishId_idx").on(table.wishId),
    index("WishCandidate_productId_idx").on(table.productId),
  ],
);

export const task = pgTable(
  "Task",
  generatedTaskColumns({
    project: (): AnyPgColumn => project.id,
    product: (): AnyPgColumn => product.id,
    task: (): AnyPgColumn => task.id,
  }),
  (table) => [
    shortcodeUnique("Task", table.shortcode),
    uniqueIndex("Task_notionPageId_key")
      .on(table.notionPageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Task_projectId_idx").on(table.projectId),
    index("Task_subjectProductId_idx").on(table.subjectProductId),
    index("Task_status_idx").on(table.status),
    index("Task_dueDate_idx").on(table.dueDate),
    index("Task_parentTaskId_idx").on(table.parentTaskId),
  ],
);

export const taskDependency = pgTable(
  "TaskDependency",
  {
    id: pkUuid(),
    taskId: uuid("taskId")
      .notNull()
      .$type<TaskId>()
      .references(() => task.id),
    blockedByTaskId: uuid("blockedByTaskId")
      .notNull()
      .$type<TaskId>()
      .references(() => task.id),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("TaskDependency_pair_key").on(
      table.taskId,
      table.blockedByTaskId,
    ),
    index("TaskDependency_blockedBy_idx").on(table.blockedByTaskId),
    check(
      "TaskDependency_no_self_check",
      sql`${table.taskId} <> ${table.blockedByTaskId}`,
    ),
  ],
);

/**
 * The roster of places money goes. `Vendor ──< Purchase ──< Expense`: this was
 * a free-text `vendor` column repeated on every ledger row until the charge got
 * its own table, which is why a vendor's documents and contractor metadata had
 * nowhere to live.
 */
export const vendor = pgTable(
  "Vendor",
  generatedVendorColumns({ image: (): AnyPgColumn => image.id }),
  (table) => [
    shortcodeUnique("Vendor", table.shortcode),
    uniqueIndex("Vendor_name_key")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Vendor_logoImageId_idx").on(table.logoImageId),
    check(
      "Vendor_orderEvidence_check",
      sql`${table.orderEvidence} IS NULL OR ${table.orderEvidence} IN ('online_account', 'receipt_only', 'not_expected')`,
    ),
    check(
      "Vendor_returnWindowDays_check",
      sql`${table.returnWindowDays} IS NULL OR ${table.returnWindowDays} >= 0`,
    ),
  ],
);

/** A durable economic participant in the household ledger. */
export const ledgerParty = pgTable(
  "LedgerParty",
  {
    ...generatedLedgerPartyColumns(),
    // Auth ownership is intentionally storage-only: a member claims it from
    // Settings, never through generic ledger-party create/update forms.
    userId: text("userId")
      .$type<UserId>()
      .references(() => user.id),
  },
  (table) => [
    shortcodeUnique("LedgerParty", table.shortcode),
    index("LedgerParty_kind_idx").on(table.kind),
    uniqueIndex("LedgerParty_household_singleton_key")
      .on(table.kind)
      .where(sql`${table.deletedAt} IS NULL AND ${table.kind} = 'household'`),
    uniqueIndex("LedgerParty_member_user_key")
      .on(table.userId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.userId} IS NOT NULL`),
    check(
      "LedgerParty_kind_check",
      sql`${table.kind} IN ('member', 'guest', 'household')`,
    ),
    check(
      "LedgerParty_user_member_check",
      sql`${table.userId} IS NULL OR ${table.kind} = 'member'`,
    ),
  ],
);

export const financialAccount = pgTable(
  "FinancialAccount",
  generatedFinancialAccountColumns({
    ledgerParty: (): AnyPgColumn => ledgerParty.id,
  }),
  (table) => [
    shortcodeUnique("FinancialAccount", table.shortcode),
    index("FinancialAccount_name_idx").on(table.name),
    index("FinancialAccount_provisional_idx").on(table.provisional),
    index("FinancialAccount_ledgerPartyId_idx").on(table.ledgerPartyId),
  ],
);

export const vendorAccount = pgTable(
  "VendorAccount",
  generatedVendorAccountColumns({
    vendor: (): AnyPgColumn => vendor.id,
    ledgerParty: (): AnyPgColumn => ledgerParty.id,
  }),
  (table) => [
    shortcodeUnique("VendorAccount", table.shortcode),
    uniqueIndex("VendorAccount_vendor_member_key")
      .on(table.vendorId, table.ledgerPartyId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("VendorAccount_vendorId_idx").on(table.vendorId),
    index("VendorAccount_ledgerPartyId_idx").on(table.ledgerPartyId),
    check(
      "VendorAccount_status_check",
      sql`${table.status} IN ('active', 'paused_auth', 'paused_offline', 'disabled')`,
    ),
    check(
      "VendorAccount_browser_check",
      sql`${table.browser} IN ('chrome', 'safari')`,
    ),
  ],
);

/**
 * One vendor order, receipt, or deliberately separate purchase event — the home
 * for vendor-side truth (literal stated total, documents, and identity).
 *
 * **No money is summed from this table.** Spend is `SUM(expense.cost)`.
 */
export const purchase = pgTable(
  "Purchase",
  {
    ...generatedPurchaseColumns({
      project: (): AnyPgColumn => project.id,
      vendor: (): AnyPgColumn => vendor.id,
      vendorAccount: (): AnyPgColumn => vendorAccount.id,
    }),
    importRunId: uuid("importRunId").references(
      (): AnyPgColumn => importRun.id,
    ),
  },
  (table) => [
    shortcodeUnique("Purchase", table.shortcode),
    // One order = one purchase. PARTIAL on `orderId IS NOT NULL`, which is what
    // lets the many `(vendorId, null)` purchase events coexist. This index is
    // also what makes `findOrCreatePurchase` unambiguous
    // (no "which purchase?" branch on the import hot path) and why no
    // `splitPurchase` operation is needed at all.
    uniqueIndex("Purchase_vendorId_orderId_key")
      .on(table.vendorId, table.orderId)
      .where(sql`${table.orderId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    index("Purchase_defaultProjectId_idx").on(table.defaultProjectId),
    index("Purchase_vendorId_idx").on(table.vendorId),
    index("Purchase_vendorAccountId_idx").on(table.vendorAccountId),
    index("Purchase_importRunId_idx").on(table.importRunId),
    index("Purchase_date_idx").on(table.date),
    check(
      "Purchase_statedTotal_whole_cent_check",
      sql`${table.statedTotal} IS NULL OR abs(${table.statedTotal} * 100 - round(${table.statedTotal} * 100)) < 0.0000001`,
    ),
    index("Purchase_orderId_gin_idx").using(
      "gin",
      sql`${table.orderId} gin_trgm_ops`,
    ),
    index("Purchase_displayLabel_gin_idx").using(
      "gin",
      sql`${table.displayLabel} gin_trgm_ops`,
    ),
  ],
);

export const purchaseImage = pgTable(
  "PurchaseImage",
  {
    id: pkUuid(),
    purchaseId: uuid("purchaseId")
      .notNull()
      .$type<PurchaseId>()
      .references(() => purchase.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    documentKind: text("documentKind", {
      enum: purchaseDocumentKindValues,
    })
      .notNull()
      .$type<PurchaseDocumentKind>()
      .default("other"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("PurchaseImage_purchaseId_imageId_key")
      .on(table.purchaseId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("PurchaseImage_purchaseId_idx").on(table.purchaseId),
    index("PurchaseImage_imageId_idx").on(table.imageId),
  ],
);

export const purchaseProduct = pgTable(
  "PurchaseProduct",
  {
    id: pkUuid(),
    purchaseId: uuid("purchaseId")
      .notNull()
      .$type<PurchaseId>()
      .references(() => purchase.id),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("PurchaseProduct_purchaseId_productId_key")
      .on(table.purchaseId, table.productId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("PurchaseProduct_purchaseId_idx").on(table.purchaseId),
    index("PurchaseProduct_productId_idx").on(table.productId),
  ],
);

/** One durable attempt to discover, fetch, extract, write, and audit evidence. */
export const importRun = pgTable(
  "ImportRun",
  {
    id: pkUuid(),
    publicId: text("publicId").notNull(),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    actorUserId: text("actorUserId")
      .notNull()
      .$type<UserId>()
      .references(() => user.id),
    actorName: text("actorName").notNull(),
    actorEmail: text("actorEmail").notNull(),
    actorLedgerPartyShortcode: text("actorLedgerPartyShortcode").notNull(),
    actorLedgerPartyName: text("actorLedgerPartyName").notNull(),
    actorLedgerPartyKind: text("actorLedgerPartyKind").notNull(),
    vendorAccountId: uuid("vendorAccountId").references(() => vendorAccount.id),
    vendorId: uuid("vendorId")
      .$type<VendorId>()
      .references(() => vendor.id),
    predecessorRunId: uuid("predecessorRunId").references(
      (): AnyPgColumn => importRun.id,
    ),
    purpose: text("purpose").notNull().default("account_sync"),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"),
    coordinatorModel: text("coordinatorModel")
      .notNull()
      .default("gpt-5.6-terra"),
    skillRevision: text("skillRevision").notNull().default("purchase-import@1"),
    runtimeRevision: text("runtimeRevision").notNull().default("flue@1"),
    decisionRevision: integer("decisionRevision").notNull().default(1),
    startedAt: timestamp("startedAt", { mode: "date" }).notNull().defaultNow(),
    endedAt: timestamp("endedAt", { mode: "date" }),
    ordersSeen: integer("ordersSeen").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    auditedAt: timestamp("auditedAt", { mode: "date" }),
    failureCode: text("failureCode"),
    /** Stable queue generation; duplicate and late deliveries are fenced to it. */
    dispatchEventId: text("dispatchEventId"),
    dispatchAttempts: integer("dispatchAttempts").notNull().default(0),
    dispatchError: text("dispatchError"),
    coordinatorStartedAt: timestamp("coordinatorStartedAt", { mode: "date" }),
    agentSessionId: text("agentSessionId"),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ImportRun_publicId_unique").on(table.publicId),
    index("ImportRun_party_started_idx").on(
      table.ledgerPartyId,
      table.startedAt.desc(),
    ),
    index("ImportRun_vendorAccount_started_idx").on(
      table.vendorAccountId,
      table.startedAt.desc(),
    ),
    check(
      "ImportRun_trigger_check",
      sql`${table.trigger} IN ('foreground', 'discovery', 'manual', 'backfill')`,
    ),
    check(
      "ImportRun_status_check",
      sql`${table.status} IN ('running', 'paused_auth', 'paused_offline', 'paused_approval', 'needs_review', 'completed', 'failed', 'dispatch_failed')`,
    ),
    check(
      "ImportRun_purpose_check",
      sql`${table.purpose} IN ('account_sync', 'purchase_validation', 'product_enrichment')`,
    ),
    uniqueIndex("ImportRun_dispatch_event_unique")
      .on(table.dispatchEventId)
      .where(sql`${table.dispatchEventId} IS NOT NULL`),
    uniqueIndex("ImportRun_one_active_vendor_account_key")
      .on(table.vendorAccountId)
      .where(
        sql`${table.vendorAccountId} IS NOT NULL AND ${table.status} IN ('running', 'paused_auth', 'paused_offline', 'paused_approval')`,
      ),
  ],
);

/** Explicit no-op-validation/enrichment targets; ImportRunMutation remains writes-only. */
export const importRunTarget = pgTable(
  "ImportRunTarget",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    purchaseId: uuid("purchaseId")
      .$type<PurchaseId>()
      .references(() => purchase.id),
    productId: uuid("productId")
      .$type<ProductId>()
      .references(() => product.id),
    vendorAccountId: uuid("vendorAccountId").references(() => vendorAccount.id),
    sourceKind: text("sourceKind"),
    sourceExternalKey: text("sourceExternalKey"),
    state: text("state").notNull().default("pending"),
    targetFingerprint: text("targetFingerprint").notNull(),
    evidenceFingerprint: text("evidenceFingerprint"),
    outcome: text("outcome"),
    warning: text("warning"),
    diff: jsonb("diff"),
    preparedAt: timestamp("preparedAt", { mode: "date" }),
    completedAt: timestamp("completedAt", { mode: "date" }),
    ...baseTimestamps(),
  },
  (table) => [
    index("ImportRunTarget_run_idx").on(table.runId),
    index("ImportRunTarget_purchase_idx").on(table.purchaseId),
    index("ImportRunTarget_product_idx").on(table.productId),
    uniqueIndex("ImportRunTarget_run_purchase_key")
      .on(table.runId, table.purchaseId)
      .where(sql`${table.purchaseId} IS NOT NULL`),
    uniqueIndex("ImportRunTarget_run_product_key")
      .on(table.runId, table.productId)
      .where(sql`${table.productId} IS NOT NULL`),
    check(
      "ImportRunTarget_exactly_one_target_check",
      sql`((${table.purchaseId} IS NOT NULL)::int + (${table.productId} IS NOT NULL)::int) = 1`,
    ),
    check(
      "ImportRunTarget_state_check",
      sql`${table.state} IN ('pending', 'prepared', 'completed', 'skipped', 'unresolved', 'needs_evidence', 'unavailable')`,
    ),
    check(
      "ImportRunTarget_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('replayed', 'raw_evidence_drift', 'semantic_drift', 'enriched', 'unavailable', 'skipped')`,
    ),
  ],
);

/** Immutable R2-backed evidence scoped to a run target, never a shared Image. */
export const importRunEvidence = pgTable(
  "ImportRunEvidence",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    targetId: uuid("targetId")
      .notNull()
      .references(() => importRunTarget.id),
    kind: text("kind").notNull(),
    objectKey: text("objectKey").notNull(),
    checksum: text("checksum").notNull(),
    mediaType: text("mediaType").notNull(),
    byteSize: integer("byteSize"),
    sourceMetadata: jsonb("sourceMetadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ImportRunEvidence_object_key_unique").on(table.objectKey),
    index("ImportRunEvidence_run_target_idx").on(table.runId, table.targetId),
    check(
      "ImportRunEvidence_kind_check",
      sql`${table.kind} IN ('browser_capture', 'gmail_attachment', 'manual_upload')`,
    ),
  ],
);

/** Stable source ownership makes browser pages, email, exports, and orderless receipts replay-safe. */
export const importSourceClaim = pgTable(
  "ImportSourceClaim",
  {
    id: pkUuid(),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    vendorAccountId: uuid("vendorAccountId").references(() => vendorAccount.id),
    kind: text("kind").notNull(),
    externalKey: text("externalKey").notNull(),
    checksum: text("checksum").notNull(),
    purchaseId: uuid("purchaseId")
      .$type<PurchaseId>()
      .references(() => purchase.id),
    firstRunId: uuid("firstRunId")
      .notNull()
      .references(() => importRun.id),
    lastRunId: uuid("lastRunId")
      .notNull()
      .references(() => importRun.id),
    outputFingerprint: text("outputFingerprint").notNull(),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ImportSourceClaim_source_key").on(
      table.ledgerPartyId,
      table.kind,
      table.externalKey,
    ),
    index("ImportSourceClaim_purchase_idx").on(table.purchaseId),
    check(
      "ImportSourceClaim_kind_check",
      sql`${table.kind} IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export')`,
    ),
  ],
);

/** Explicit run provenance for every row mutation, independent of AuditLog's actor shape. */
export const importRunMutation = pgTable(
  "ImportRunMutation",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    targetType: text("targetType").notNull(),
    targetId: uuid("targetId").notNull(),
    mutationKind: text("mutationKind").notNull(),
    fields: jsonb("fields")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    postFingerprint: text("postFingerprint").notNull(),
    auditLogId: uuid("auditLogId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ImportRunMutation_run_idx").on(table.runId),
    index("ImportRunMutation_target_idx").on(table.targetType, table.targetId),
  ],
);

/** Replay-safe boundary for Flue durable tools and external side effects. */
export const importRunOperation = pgTable(
  "ImportRunOperation",
  {
    id: pkUuid(),
    executor:
      jsonb("executor").$type<
        import("@cubby/schemas/activity").ActivityExecutor
      >(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    operationId: text("operationId").notNull(),
    kind: text("kind").notNull(),
    inputFingerprint: text("inputFingerprint").notNull(),
    state: text("state").notNull().default("started"),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("startedAt", { mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completedAt", { mode: "date" }),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ImportRunOperation_run_operation_key").on(
      table.runId,
      table.operationId,
    ),
    index("ImportRunOperation_run_state_idx").on(table.runId, table.state),
    check(
      "ImportRunOperation_state_check",
      sql`${table.state} IN ('started', 'paused_approval', 'completed', 'failed')`,
    ),
  ],
);

/** Idempotent progress events mirrored from the private Flue coordinator. */
export const importRunProgress = pgTable(
  "ImportRunProgress",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    eventId: text("eventId").notNull(),
    phase: text("phase").notNull(),
    currentItem: text("currentItem"),
    awaitingApproval: boolean("awaitingApproval").notNull().default(false),
    detail: text("detail"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ImportRunProgress_eventId_unique").on(table.eventId),
    index("ImportRunProgress_run_created_idx").on(
      table.runId,
      table.createdAt.desc(),
    ),
  ],
);

/** Immutable record of which household member prompted, approved, or stopped a run. */
export const importRunControlEvent = pgTable(
  "ImportRunControlEvent",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    action: text("action").notNull(),
    controllerUserId: text("controllerUserId").notNull().$type<UserId>(),
    controllerName: text("controllerName").notNull(),
    controllerEmail: text("controllerEmail").notNull(),
    controllerLedgerPartyId: uuid("controllerLedgerPartyId")
      .notNull()
      .$type<LedgerPartyId>(),
    controllerLedgerPartyShortcode: text(
      "controllerLedgerPartyShortcode",
    ).notNull(),
    controllerLedgerPartyName: text("controllerLedgerPartyName").notNull(),
    controllerLedgerPartyKind: text("controllerLedgerPartyKind").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("ImportRunControlEvent_run_created_idx").on(
      table.runId,
      table.createdAt,
    ),
    check(
      "ImportRunControlEvent_action_check",
      sql`${table.action} IN ('prompt', 'abort', 'pause', 'resume', 'cancel', 'approve', 'reject', 'retry', 'retry_dispatch', 'upload_evidence', 'no_evidence_available', 'escalate_sol')`,
    ),
  ],
);

/** Immutable prepared order evidence; commit decisions live in the operation ledger. */
export const importPreparedOrder = pgTable(
  "ImportPreparedOrder",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    prepareOperationId: text("prepareOperationId").notNull(),
    itemOperationId: text("itemOperationId").notNull(),
    stableOrderId: text("stableOrderId").notNull(),
    sourceKind: text("sourceKind").notNull(),
    sourceExternalKey: text("sourceExternalKey").notNull(),
    sourceChecksum: text("sourceChecksum").notNull(),
    evidenceChecksum: text("evidenceChecksum").notNull(),
    extractionRevision: text("extractionRevision").notNull(),
    extraction: jsonb("extraction").notNull(),
    primaryDocumentImageId: uuid("primaryDocumentImageId").references(
      () => image.id,
    ),
    screenshotImageId: uuid("screenshotImageId").references(() => image.id),
    targetFingerprint: text("targetFingerprint").notNull(),
    evidenceFingerprint: text("evidenceFingerprint").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ImportPreparedOrder_run_item_operation_key").on(
      table.runId,
      table.itemOperationId,
    ),
    uniqueIndex("ImportPreparedOrder_run_stable_order_key").on(
      table.runId,
      table.stableOrderId,
    ),
    index("ImportPreparedOrder_prepare_operation_idx").on(
      table.runId,
      table.prepareOperationId,
    ),
    check(
      "ImportPreparedOrder_source_kind_check",
      sql`${table.sourceKind} IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export')`,
    ),
  ],
);

/** Immutable normalized line, its identifiers, and the bounded candidates shown for approval. */
export const importPreparedLine = pgTable(
  "ImportPreparedLine",
  {
    id: pkUuid(),
    preparedOrderId: uuid("preparedOrderId")
      .notNull()
      .references(() => importPreparedOrder.id),
    stableLineId: text("stableLineId").notNull(),
    position: integer("position").notNull(),
    line: jsonb("line").notNull(),
    identifiers: jsonb("identifiers").$type<Record<string, string>>().notNull(),
    candidates: jsonb("candidates").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ImportPreparedLine_order_stable_line_key").on(
      table.preparedOrderId,
      table.stableLineId,
    ),
    uniqueIndex("ImportPreparedLine_order_position_key").on(
      table.preparedOrderId,
      table.position,
    ),
  ],
);

/** One exact human grant; commit rechecks fingerprints and consumes it transactionally. */
export const importRunApproval = pgTable(
  "ImportRunApproval",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => importRun.id),
    operationId: text("operationId").notNull(),
    operationKind: text("operationKind").notNull(),
    args: jsonb("args").notNull(),
    argsFingerprint: text("argsFingerprint").notNull(),
    targetFingerprint: text("targetFingerprint").notNull(),
    evidenceFingerprint: text("evidenceFingerprint").notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    decidedByUserId: text("decidedByUserId")
      .$type<UserId>()
      .references(() => user.id),
    decidedAt: timestamp("decidedAt", { mode: "date" }),
    rejectedAt: timestamp("rejectedAt", { mode: "date" }),
    consumedAt: timestamp("consumedAt", { mode: "date" }),
    invalidatedAt: timestamp("invalidatedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("ImportRunApproval_run_operation_key").on(
      table.runId,
      table.operationId,
    ),
    index("ImportRunApproval_run_state_idx").on(table.runId, table.state),
    check(
      "ImportRunApproval_state_check",
      sql`${table.state} IN ('pending', 'granted', 'rejected', 'consumed', 'invalidated')`,
    ),
  ],
);

export const importFinding = pgTable(
  "ImportFinding",
  {
    id: pkUuid(),
    importRunId: uuid("importRunId").references(() => importRun.id),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    targetType: text("targetType").notNull(),
    targetId: uuid("targetId").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    proposedFix: jsonb("proposedFix"),
    evidenceFingerprint: text("evidenceFingerprint").notNull(),
    autoApplied: boolean("autoApplied").notNull().default(false),
    probability: real("probability"),
    status: text("status").notNull().default("open"),
    resolvedAt: timestamp("resolvedAt", { mode: "date" }),
    expiresAt: timestamp("expiresAt", { mode: "date" }),
    resolvedByUserId: text("resolvedByUserId").references(() => user.id),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ImportFinding_open_evidence_key")
      .on(
        table.ledgerPartyId,
        table.targetType,
        table.targetId,
        table.kind,
        table.evidenceFingerprint,
      )
      .where(sql`${table.status} = 'open'`),
    index("ImportFinding_status_idx").on(table.status, table.createdAt.desc()),
    check(
      "ImportFinding_status_check",
      sql`${table.status} IN ('open', 'applied', 'dismissed')`,
    ),
    check(
      "ImportFinding_target_check",
      sql`${table.targetType} IN ('purchase', 'expense', 'product', 'import_run')`,
    ),
  ],
);

export const importHunt = pgTable(
  "ImportHunt",
  {
    id: pkUuid(),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    financialTransactionId: uuid("financialTransactionId")
      .notNull()
      .$type<FinancialTransactionId>()
      .references(() => financialTransaction.id),
    vendorId: uuid("vendorId")
      .$type<VendorId>()
      .references(() => vendor.id),
    vendorAccountId: uuid("vendorAccountId").references(() => vendorAccount.id),
    state: text("state").notNull().default("pending_mail"),
    dateFrom: date("dateFrom", { mode: "string" }).notNull(),
    dateTo: date("dateTo", { mode: "string" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    matchedOrderIds: jsonb("matchedOrderIds")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    error: text("error"),
    receiptImageId: uuid("receiptImageId").references(() => image.id),
    receiptRunId: uuid("receiptRunId").references(() => importRun.id),
    receiptQueuedAt: timestamp("receiptQueuedAt", { mode: "date" }),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ImportHunt_transaction_key").on(table.financialTransactionId),
    index("ImportHunt_worklist_idx").on(table.state, table.updatedAt),
    uniqueIndex("ImportHunt_receipt_image_key")
      .on(table.id, table.receiptImageId)
      .where(sql`${table.receiptImageId} IS NOT NULL`),
    index("ImportHunt_receipt_run_idx").on(table.receiptRunId),
  ],
);

/** Human-confirmed merchant routing; never inferred repeatedly at write time. */
export const merchantVendorRule = pgTable(
  "MerchantVendorRule",
  {
    id: pkUuid(),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    normalizedMerchant: text("normalizedMerchant").notNull(),
    vendorId: uuid("vendorId")
      .notNull()
      .$type<VendorId>()
      .references(() => vendor.id),
    confirmedByUserId: text("confirmedByUserId")
      .notNull()
      .references(() => user.id),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("MerchantVendorRule_party_merchant_key").on(
      table.ledgerPartyId,
      table.normalizedMerchant,
    ),
  ],
);

export const mailboxCursor = pgTable(
  "MailboxCursor",
  {
    id: pkUuid(),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    provider: text("provider").notNull().default("gmail"),
    historyId: text("historyId"),
    lastPolledAt: timestamp("lastPolledAt", { mode: "date" }),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("MailboxCursor_party_provider_key").on(
      table.ledgerPartyId,
      table.provider,
    ),
  ],
);

export const orderMail = pgTable(
  "OrderMail",
  {
    id: pkUuid(),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    vendorId: uuid("vendorId")
      .$type<VendorId>()
      .references(() => vendor.id),
    messageId: text("messageId").notNull(),
    threadId: text("threadId"),
    historyId: text("historyId"),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    receivedAt: timestamp("receivedAt", { mode: "date" }).notNull(),
    rawChecksum: text("rawChecksum").notNull(),
    content: jsonb("content")
      .$type<{
        snippet: string | null;
        bodyText: string | null;
        bodyHtml: string | null;
      }>()
      .notNull()
      .default(sql`'{"snippet":null,"bodyText":null,"bodyHtml":null}'::jsonb`),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("OrderMail_party_message_key").on(
      table.ledgerPartyId,
      table.messageId,
    ),
    index("OrderMail_party_received_idx").on(
      table.ledgerPartyId,
      table.receivedAt.desc(),
    ),
  ],
);

export const orderMailEvent = pgTable(
  "OrderMailEvent",
  {
    id: pkUuid(),
    orderMailId: uuid("orderMailId")
      .notNull()
      .references(() => orderMail.id),
    event: text("event").notNull(),
    orderId: text("orderId"),
    amount: doublePrecision("amount"),
    currency: text("currency"),
    occurredAt: timestamp("occurredAt", { mode: "date" }),
    sourceKey: text("sourceKey").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("OrderMailEvent_source_key").on(
      table.orderMailId,
      table.sourceKey,
    ),
    index("OrderMailEvent_order_idx").on(table.orderId),
  ],
);

export const orderMailAttachment = pgTable(
  "OrderMailAttachment",
  {
    id: pkUuid(),
    orderMailId: uuid("orderMailId")
      .notNull()
      .references(() => orderMail.id),
    providerAttachmentId: text("providerAttachmentId").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mimeType").notNull(),
    checksum: text("checksum").notNull(),
    pendingDataBase64Url: text("pendingDataBase64Url"),
    imageId: uuid("imageId").references(() => image.id),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("OrderMailAttachment_provider_key").on(
      table.orderMailId,
      table.providerAttachmentId,
    ),
  ],
);

export const purchasePaymentEvidence = pgTable(
  "PurchasePaymentEvidence",
  {
    id: pkUuid(),
    purchaseId: uuid("purchaseId")
      .notNull()
      .$type<PurchaseId>()
      .references(() => purchase.id),
    sourceClaimId: uuid("sourceClaimId")
      .notNull()
      .references(() => importSourceClaim.id),
    amount: doublePrecision("amount").notNull(),
    chargedAt: timestamp("chargedAt", { mode: "date" }),
    cardLastFour: text("cardLastFour"),
    description: text("description"),
    evidenceIndex: integer("evidenceIndex").notNull(),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("PurchasePaymentEvidence_source_index_key").on(
      table.sourceClaimId,
      table.evidenceIndex,
    ),
    index("PurchasePaymentEvidence_purchase_idx").on(table.purchaseId),
  ],
);

// What's inside a kit. A combo tool kit or a multi-pack is a Product like any
// other — it keeps its own UPC, model, ASIN, image, and purchase history — but
// it is ALSO made of other Products, and this table is the only place that's
// recorded. It exists because splitting a kit used to mean deleting the kit
// Product outright, which destroyed the one row holding its own identity and
// provenance; now the kit survives the split and this table says what came out
// of it. One row per distinct component; a 4-pack of one part is one row with
// `quantity: 4`, a 9-piece kit is nine rows.
//
// Non-entity, same as PurchaseProduct: no shortcode, no entity-manifest entry.
// A component row is meaningless without both the kit and the part it names.
export const productComponent = pgTable(
  "ProductComponent",
  {
    id: pkUuid(),
    parentProductId: uuid("parentProductId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    componentProductId: uuid("componentProductId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    quantity: integer("quantity").notNull().default(1),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ProductComponent_parentProductId_componentProductId_key")
      .on(table.parentProductId, table.componentProductId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ProductComponent_parentProductId_idx").on(table.parentProductId),
    index("ProductComponent_componentProductId_idx").on(
      table.componentProductId,
    ),
    check("ProductComponent_quantity_check", sql`${table.quantity} >= 1`),
    // A product cannot be its own component. Deliberately narrow: catching a
    // longer cycle (a kit nested inside one of its own components several
    // hops down) is a graph-traversal question for the write path, not
    // something a single-row CHECK can express.
    check(
      "ProductComponent_not_self_check",
      sql`${table.parentProductId} <> ${table.componentProductId}`,
    ),
  ],
);

/**
 * A settlement-side event. Amounts are evidence only: they never participate
 * in spend/project/calendar rollups, which remain derived from Expense.cost.
 */
export const financialTransaction = pgTable(
  "FinancialTransaction",
  generatedFinancialTransactionColumns({
    financialAccount: (): AnyPgColumn => financialAccount.id,
    ledgerTransfer: (): AnyPgColumn => ledgerTransfer.id,
  }),
  (table) => [
    shortcodeUnique("FinancialTransaction", table.shortcode),
    index("FinancialTransaction_accountId_idx").on(table.accountId),
    index("FinancialTransaction_ledgerTransferId_idx").on(
      table.ledgerTransferId,
    ),
    uniqueIndex("FinancialTransaction_ledgerTransferId_positive_evidence_key")
      .on(table.ledgerTransferId)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.ledgerTransferId} IS NOT NULL AND ${table.amount} > 0`,
      ),
    uniqueIndex("FinancialTransaction_ledgerTransferId_negative_evidence_key")
      .on(table.ledgerTransferId)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.ledgerTransferId} IS NOT NULL AND ${table.amount} < 0`,
      ),
    index("FinancialTransaction_kind_idx").on(table.kind),
    index("FinancialTransaction_status_idx").on(table.status),
    index("FinancialTransaction_transactionDate_idx").on(table.transactionDate),
    index("FinancialTransaction_postedDate_idx").on(table.postedDate),
    // Serves the `sourceRefs @> '[{source,externalId}]'` containment probes that
    // every statement-import write and every reconciliation read performs.
    // Plain jsonb_ops — naming an opclass here produces perpetual `db:push`
    // drift.
    index("FinancialTransaction_sourceRefs_gin_idx").using(
      "gin",
      table.sourceRefs,
    ),
    check(
      "FinancialTransaction_amount_whole_cent_check",
      sql`${table.amount} <> 0 AND abs(${table.amount} * 100 - round(${table.amount} * 100)) < 0.0000001`,
    ),
    check(
      "FinancialTransaction_posted_date_check",
      sql`${table.status} <> 'posted' OR ${table.postedDate} IS NOT NULL`,
    ),
  ],
);

export const financialTransactionAllocation = pgTable(
  "FinancialTransactionAllocation",
  {
    id: pkUuid(),
    transactionId: uuid("transactionId")
      .notNull()
      .$type<FinancialTransactionId>()
      .references(() => financialTransaction.id),
    purchaseId: uuid("purchaseId")
      .notNull()
      .$type<PurchaseId>()
      .references(() => purchase.id),
    amount: doublePrecision("amount").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    // Partial, so unallocating and re-allocating the same pair stays legal — same
    // rule as PurchaseProduct's. One live row per (transaction, purchase): two
    // slices of one charge against one order is one slice, and merging two
    // purchases that share a transaction SUMS into this row rather than adding a
    // second (see PURCHASE_MERGE_EDGE_POLICY — `onConflictDoNothing` there would
    // silently destroy money).
    uniqueIndex("FinancialTransactionAllocation_transactionId_purchaseId_key")
      .on(table.transactionId, table.purchaseId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("FinancialTransactionAllocation_transactionId_idx").on(
      table.transactionId,
    ),
    index("FinancialTransactionAllocation_purchaseId_idx").on(table.purchaseId),
    // Same whole-cent and non-zero rules as FinancialTransaction.amount: a
    // zero-dollar allocation says nothing, and unlinking is deleting the row
    // rather than zeroing it.
    //
    // Declarable here only because push emits CHECKs inside CREATE TABLE for a
    // NEW table; it is edits to an EXISTING table's CHECK that push silently
    // ignores. Treat this expression as immutable — changing it later means a
    // hand-applied ALTER plus a pg_constraint re-read.
    check(
      "FinancialTransactionAllocation_amount_whole_cent_check",
      sql`${table.amount} <> 0 AND abs(${table.amount} * 100 - round(${table.amount} * 100)) < 0.0000001`,
    ),
  ],
);

/** A durable movement between ledger parties; it is never spend. */
export const ledgerTransfer = pgTable(
  "LedgerTransfer",
  generatedLedgerTransferColumns({
    ledgerParty: (): AnyPgColumn => ledgerParty.id,
  }),
  (table) => [
    shortcodeUnique("LedgerTransfer", table.shortcode),
    index("LedgerTransfer_fromPartyId_idx").on(table.fromPartyId),
    index("LedgerTransfer_toPartyId_idx").on(table.toPartyId),
    index("LedgerTransfer_date_idx").on(table.date),
    check(
      "LedgerTransfer_amount_whole_cent_check",
      sql`${table.amount} > 0 AND abs(${table.amount} * 100 - round(${table.amount} * 100)) < 0.0000001`,
    ),
  ],
);

export const statementImport = pgTable(
  "StatementImport",
  {
    id: pkUuid(),
    source: text("source").notNull(),
    label: text("label").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /**
     * Which date the provider's rows carry. Recorded, never resolved: one export
     * has one convention, and 19% of charges present in both Copilot and Monarch
     * are dated differently because the providers disagree on posting vs
     * transaction date. Stating it beats guessing per row.
     */
    dateKind: text("dateKind").notNull().default("unknown"),
    rowCountDeclared: integer("rowCountDeclared"),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("StatementImport_source_fingerprint_key")
      .on(table.source, table.fingerprint)
      .where(sql`${table.deletedAt} IS NULL`),
    index("StatementImport_source_idx").on(table.source),
    check(
      "StatementImport_source_slug_check",
      sql`${table.source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${table.source} = lower(trim(${table.source}))`,
    ),
    check(
      "StatementImport_dateKind_check",
      sql`${table.dateKind} IN ('posted', 'transaction', 'unknown')`,
    ),
    check(
      "StatementImport_rowCountDeclared_check",
      sql`${table.rowCountDeclared} IS NULL OR ${table.rowCountDeclared} >= 0`,
    ),
  ],
);

/**
 * One verbatim row from a provider export.
 *
 * Match state is **derived**, not stored: a row is matched when a live
 * `FinancialTransaction.sourceRefs` contains its `(source, externalId)` pair.
 * That join needs no DISTINCT only because `assertSourceRefsAvailable`
 * guarantees the pair is globally unique across live transactions — a
 * guarantee that lives in `repo/financial-transaction.ts`, so weakening it
 * there fans this out.
 *
 * The provider columns are immutable after ingest; the only mutable fields are
 * the judgments an agent explicitly writes (`accountId`, `disposition*`,
 * `supersededByRowId`, `notes`).
 */
export const statementRow = pgTable(
  "StatementRow",
  {
    id: pkUuid(),
    batchId: uuid("batchId")
      .notNull()
      .references(() => statementImport.id),
    source: text("source").notNull(),
    externalId: text("externalId").notNull(),

    accountDescriptor: text("accountDescriptor").notNull(),
    statementDate: date("statementDate", { mode: "string" }).notNull(),
    amount: doublePrecision("amount").notNull(),
    /**
     * The export's own signed figure. Earns its bytes: with it,
     * (source, accountDescriptor, statementDate, providerAmount,
     * rawDescription) reproduces the hash payload exactly, so the ledger can
     * audit its own identity function. Without it `externalId` is an
     * unverifiable opaque token — and that hash is the whole matching mechanism.
     */
    providerAmount: doublePrecision("providerAmount").notNull(),
    merchant: text("merchant"),
    rawDescription: text("rawDescription").notNull(),
    sourceCategory: text("sourceCategory"),
    providerStatus: text("providerStatus"),
    providerNotes: text("providerNotes"),

    accountId: uuid("accountId")
      .$type<FinancialAccountId>()
      .references(() => financialAccount.id),
    disposition: text("disposition").notNull().default("open"),
    dispositionReason: text("dispositionReason"),
    dispositionNote: text("dispositionNote"),
    /**
     * A pending row that posts on a different date is a *different* row — the
     * export really did contain two. This link is agent-written, never
     * inferred, and drops the predecessor from the worklist without deleting
     * the evidence that it existed.
     */
    supersededByRowId: uuid("supersededByRowId").references(
      (): AnyPgColumn => statementRow.id,
    ),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("StatementRow_source_externalId_key")
      .on(table.source, table.externalId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("StatementRow_batchId_idx").on(table.batchId),
    index("StatementRow_accountId_idx").on(table.accountId),
    index("StatementRow_statementDate_idx").on(table.statementDate),
    index("StatementRow_worklist_idx")
      .on(table.statementDate.desc())
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.disposition} = 'open' AND ${table.supersededByRowId} IS NULL`,
      ),
    index("StatementRow_account_date_amount_idx").on(
      table.accountId,
      table.statementDate,
      table.amount,
    ),
    // The drift sweep groups on the DESCRIPTOR, not `accountId` — that column
    // is an agent-written judgment and is null for most of the backlog, so the
    // index above does not serve the group. Deliberately not partial on
    // `deletedAt`: `drizzle-kit push` applies index predicates as a no-op, so a
    // partial index here would exist in the schema file and nowhere else.
    index("StatementRow_descriptor_date_amount_idx").on(
      table.source,
      table.accountDescriptor,
      table.statementDate,
      table.providerAmount,
    ),
    index("StatementRow_rawDescription_gin_idx").using(
      "gin",
      sql`${table.rawDescription} gin_trgm_ops`,
    ),
    check(
      "StatementRow_source_slug_check",
      sql`${table.source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${table.source} = lower(trim(${table.source}))`,
    ),
    check(
      "StatementRow_amount_whole_cent_check",
      sql`${table.amount} <> 0 AND abs(${table.amount} * 100 - round(${table.amount} * 100)) < 0.0000001`,
    ),
    check(
      "StatementRow_providerAmount_whole_cent_check",
      sql`${table.providerAmount} <> 0 AND abs(${table.providerAmount} * 100 - round(${table.providerAmount} * 100)) < 0.0000001`,
    ),
    check(
      "StatementRow_providerStatus_check",
      sql`${table.providerStatus} IS NULL OR ${table.providerStatus} IN ('posted', 'pending')`,
    ),
    // Ignoring a row is a judgment and must carry its reasoning; leaving it open
    // is the default and needs none.
    check(
      "StatementRow_disposition_check",
      sql`(${table.disposition} = 'open' AND ${table.dispositionReason} IS NULL AND ${table.dispositionNote} IS NULL)
          OR (${table.disposition} = 'ignored' AND ${table.dispositionReason} IS NOT NULL AND ${table.dispositionNote} IS NOT NULL)`,
    ),
    // The enum is enforced by zod at the router/MCP boundary, but the bulk
    // disposition scripts write this column over raw SQL and bypass that. A
    // typo would store cleanly and then throw on the read path, 500ing the list
    // for the whole source — so the vocabulary is pinned here too.
    check(
      "StatementRow_dispositionReason_check",
      sql`${table.dispositionReason} IS NULL OR ${table.dispositionReason} IN
          ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other')`,
    ),
    check(
      "StatementRow_externalId_format_check",
      sql`${table.externalId} ~ '^v1:[0-9a-f]{64}$'`,
    ),
  ],
);

export const expense = pgTable(
  "Expense",
  generatedExpenseColumns({
    project: (): AnyPgColumn => project.id,
    product: (): AnyPgColumn => product.id,
    purchase: (): AnyPgColumn => purchase.id,
  }),
  (table) => [
    shortcodeUnique("Expense", table.shortcode),
    // Apply explicitly in production: drizzle-kit push does not diff CHECKs.
    check(
      "Expense_date_cost_check",
      sql`${table.date} IS NOT NULL OR (${table.cost} IS NOT NULL AND ${table.cost} = 0)`,
    ),
    check(
      "Expense_live_charge_assignment_check",
      sql`${table.deletedAt} IS NOT NULL OR ${table.lineKind} = 'principal' OR (${table.projectId} IS NULL AND ${table.purchaseId} IS NOT NULL)`,
    ),
    uniqueIndex("Expense_notionPageId_key")
      .on(table.notionPageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Expense_projectId_idx").on(table.projectId),
    index("Expense_productId_idx").on(table.productId),
    index("Expense_date_idx").on(table.date),
    index("Expense_costType_idx").on(table.costType),
    index("Expense_lineKind_idx").on(table.lineKind),
    index("Expense_name_gin_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    index("Expense_purchaseId_idx").on(table.purchaseId),
    check(
      "Expense_cost_whole_cent_check",
      sql`${table.cost} IS NULL OR abs(${table.cost} * 100 - round(${table.cost} * 100)) < 0.0000001`,
    ),
    // Signed; zero only where the money is known to be negative — see the
    // ledger rule on `productQuantity`.
    //
    // The `cost IS NOT NULL` guard is load-bearing and is NOT redundant with
    // `cost < 0`. A CHECK rejects only on FALSE, and for an unclassified row
    // `NULL < 0` is NULL, so `(0 <> 0 OR NULL)` is NULL and the row would be
    // ADMITTED — quietly allowing the one shape the rule above forbids. The
    // guard collapses that NULL to FALSE. (Found in review on #772, where the
    // first version of this constraint had exactly that hole.)
    //
    // NOTE: `drizzle-kit push` does NOT diff CHECK constraints, so editing this
    // line changes tests (the template is built from schema.ts) and nothing
    // else. A change here must be applied to production by hand and read back
    // from `pg_constraint`.
    check(
      "Expense_productQuantity_check",
      sql`${table.productQuantity} IS NULL OR (${table.productId} IS NOT NULL AND (${table.productQuantity} <> 0 OR (${table.cost} IS NOT NULL AND ${table.cost} < 0)))`,
    ),
    // NOTE: `drizzle-kit push` does not diff CHECK constraints (see the longer
    // note on FinancialTransaction_purchase_settlement_check above). This one
    // requires the same hand-applied ALTER + pg_constraint read-back.
    check(
      "Expense_lineKind_productId_check",
      sql`${table.lineKind} = 'principal' OR ${table.productId} IS NULL`,
    ),
  ],
);

/** Unitless beneficiary/funder weights. Money remains solely on Expense.cost. */
export const expenseAttribution = pgTable(
  "ExpenseAttribution",
  {
    id: pkUuid<ExpenseAttributionId>(),
    expenseId: uuid("expenseId")
      .notNull()
      .$type<ExpenseId>()
      .references(() => expense.id),
    role: text("role").notNull().$type<ContributionRole>(),
    ledgerPartyId: uuid("ledgerPartyId")
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    weight: bigint("weight", { mode: "number" }).notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ExpenseAttribution_expenseId_role_ledgerPartyId_key")
      .on(table.expenseId, table.role, table.ledgerPartyId)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.ledgerPartyId} IS NOT NULL`,
      ),
    uniqueIndex("ExpenseAttribution_expenseId_role_unattributed_key")
      .on(table.expenseId, table.role)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.ledgerPartyId} IS NULL`,
      ),
    index("ExpenseAttribution_expenseId_idx").on(table.expenseId),
    index("ExpenseAttribution_ledgerPartyId_idx").on(table.ledgerPartyId),
    check(
      "ExpenseAttribution_role_check",
      sql`${table.role} IN ('beneficiary', 'funder')`,
    ),
    check(
      "ExpenseAttribution_weight_check",
      sql`${table.weight} > 0 AND ${table.weight} <= 9007199254740991`,
    ),
  ],
);

/** Canonical external evidence claimed by exactly one Expense or LedgerTransfer. */
export const ledgerSourceClaim = pgTable(
  "LedgerSourceClaim",
  {
    id: pkUuid(),
    expenseId: uuid("expenseId")
      .$type<ExpenseId>()
      .references(() => expense.id),
    ledgerTransferId: uuid("ledgerTransferId")
      .$type<LedgerTransferId>()
      .references(() => ledgerTransfer.id),
    source: text("source").notNull(),
    sourceKey: text("sourceKey").notNull(),
    sourceKeyVersion: integer("sourceKeyVersion").notNull(),
    normalizedEvidence: jsonb("normalizedEvidence")
      .notNull()
      .$type<LedgerSourceClaimNormalizedEvidence>(),
    targetAmountAtClaim: doublePrecision("targetAmountAtClaim").notNull(),
    reconciliationDecision: text("reconciliationDecision")
      .notNull()
      .$type<"amounts_match" | "accept_target_amount">(),
    reconciliationNote: text("reconciliationNote"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("LedgerSourceClaim_source_sourceKey_key").on(
      table.source,
      table.sourceKey,
    ),
    index("LedgerSourceClaim_expenseId_idx").on(table.expenseId),
    index("LedgerSourceClaim_ledgerTransferId_idx").on(table.ledgerTransferId),
    check(
      "LedgerSourceClaim_owner_check",
      sql`(${table.expenseId} IS NOT NULL) <> (${table.ledgerTransferId} IS NOT NULL)`,
    ),
    check(
      "LedgerSourceClaim_sourceKeyVersion_check",
      sql`${table.sourceKeyVersion} > 0`,
    ),
    check(
      "LedgerSourceClaim_source_check",
      sql`${table.source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${table.source} = lower(trim(${table.source}))`,
    ),
    check(
      "LedgerSourceClaim_reconciliation_check",
      sql`abs(${table.targetAmountAtClaim} * 100 - round(${table.targetAmountAtClaim} * 100)) < 0.0000001
          AND abs(((${table.normalizedEvidence}->>'amount')::double precision) * 100 - round(((${table.normalizedEvidence}->>'amount')::double precision) * 100)) < 0.0000001
          AND ((${table.reconciliationDecision} = 'amounts_match'
            AND ${table.reconciliationNote} IS NULL
            AND abs(((${table.normalizedEvidence}->>'amount')::double precision) - ${table.targetAmountAtClaim}) < 0.0000001)
          OR (${table.reconciliationDecision} = 'accept_target_amount'
            AND length(trim(${table.reconciliationNote})) > 0
            AND abs(((${table.normalizedEvidence}->>'amount')::double precision) - ${table.targetAmountAtClaim}) >= 0.0000001))`,
    ),
  ],
);

export const projectImage = pgTable(
  "ProjectImage",
  {
    id: pkUuid(),
    projectId: uuid("projectId")
      .notNull()
      .$type<ProjectId>()
      .references(() => project.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    sortOrder: integer("sortOrder").notNull().default(0),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ProjectImage_projectId_imageId_key")
      .on(table.projectId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ProjectImage_projectId_idx").on(table.projectId),
    index("ProjectImage_imageId_idx").on(table.imageId),
  ],
);

export const recipeRelations = relations(recipe, ({ one, many }) => ({
  sections: many(recipeSection),
  pointerIngredient: one(ingredient, {
    fields: [recipe.id],
    references: [ingredient.recipeId],
  }),
  cookbook: one(cookbook, {
    fields: [recipe.cookbookId],
    references: [cookbook.id],
  }),
  forkedFrom: one(recipe, {
    fields: [recipe.forkedFromRecipeId],
    references: [recipe.id],
    relationName: "RecipeForkedFrom",
  }),
  forks: many(recipe, {
    relationName: "RecipeForkedFrom",
  }),
  images: many(recipeImage),
  mealRecipes: many(mealRecipe),
}));

export const cookbookRelations = relations(cookbook, ({ one, many }) => ({
  recipes: many(recipe),
  coverImage: one(image, {
    fields: [cookbook.coverImageId],
    references: [image.id],
  }),
  product: one(product, {
    fields: [cookbook.productId],
    references: [product.id],
  }),
}));

export const recipeSectionRelations = relations(
  recipeSection,
  ({ one, many }) => ({
    recipe: one(recipe, {
      fields: [recipeSection.recipeId],
      references: [recipe.id],
    }),
    ingredients: many(recipeSectionIngredient),
  }),
);

export const ingredientRelations = relations(ingredient, ({ one, many }) => ({
  recipe: one(recipe, {
    fields: [ingredient.recipeId],
    references: [recipe.id],
  }),
  recipeSectionIngredient: many(recipeSectionIngredient),
  product: many(product, { relationName: "ProductIngredient" }),
  grownByProducts: many(product, { relationName: "ProductGrowsIngredient" }),
  mealFoodEntries: many(mealFoodEntry),
}));

export const recipeSectionIngredientRelations = relations(
  recipeSectionIngredient,
  ({ one }) => ({
    recipeSection: one(recipeSection, {
      fields: [recipeSectionIngredient.recipeSectionId],
      references: [recipeSection.id],
    }),
    ingredient: one(ingredient, {
      fields: [recipeSectionIngredient.ingredientId],
      references: [ingredient.id],
    }),
  }),
);

export const mealRelations = relations(meal, ({ many }) => ({
  recipes: many(mealRecipe),
  recipePortions: many(mealRecipePortion),
  foodEntries: many(mealFoodEntry),
  images: many(mealImage),
}));

export const mealRecipeRelations = relations(mealRecipe, ({ one, many }) => ({
  meal: one(meal, {
    fields: [mealRecipe.mealId],
    references: [meal.id],
  }),
  recipe: one(recipe, {
    fields: [mealRecipe.recipeId],
    references: [recipe.id],
  }),
  portions: many(mealRecipePortion),
}));

export const mealRecipePortionRelations = relations(
  mealRecipePortion,
  ({ one }) => ({
    mealRecipe: one(mealRecipe, {
      fields: [mealRecipePortion.mealRecipeId],
      references: [mealRecipe.id],
    }),
    meal: one(meal, {
      fields: [mealRecipePortion.mealId],
      references: [meal.id],
    }),
    ledgerParty: one(ledgerParty, {
      fields: [mealRecipePortion.ledgerPartyId],
      references: [ledgerParty.id],
    }),
  }),
);

export const mealFoodEntryRelations = relations(mealFoodEntry, ({ one }) => ({
  meal: one(meal, {
    fields: [mealFoodEntry.mealId],
    references: [meal.id],
  }),
  ledgerParty: one(ledgerParty, {
    fields: [mealFoodEntry.ledgerPartyId],
    references: [ledgerParty.id],
  }),
  ingredient: one(ingredient, {
    fields: [mealFoodEntry.ingredientId],
    references: [ingredient.id],
  }),
  product: one(product, {
    fields: [mealFoodEntry.productId],
    references: [product.id],
  }),
}));

export const productRelations = relations(product, ({ one, many }) => ({
  category: one(productCategory, {
    fields: [product.categoryId],
    references: [productCategory.id],
  }),
  ingredient: one(ingredient, {
    fields: [product.ingredientId],
    references: [ingredient.id],
    relationName: "ProductIngredient",
  }),
  growsIngredient: one(ingredient, {
    fields: [product.growsIngredientId],
    references: [ingredient.id],
    relationName: "ProductGrowsIngredient",
  }),
  unitMappings: many(productUnitMappings),
  mealFoodEntries: many(mealFoodEntry),
  conversionCoverage: one(productConversionCoverage),
  externalIds: many(productExternalId),
  inventoryEntry: many(inventoryEntry),
  images: many(productImage),
  expenses: many(expense),
  projectToolUsages: many(projectToolUsage),
  purchaseProducts: many(purchaseProduct),
  wishCandidates: many(wishCandidate),
  // Locations that ARE an instance of this product (a bin, tote, rack).
  // Distinct from `inventoryEntry`, which is stock held AT a location.
  locations: many(location),
  // Cookbooks whose physical copy this product is. `many` only because Drizzle
  // models the reverse of a nullable FK that way — in practice it's 0 or 1.
  cookbooks: many(cookbook),
  components: many(productComponent, {
    relationName: "productComponent_parentProduct",
  }),
  partOfKits: many(productComponent, {
    relationName: "productComponent_componentProduct",
  }),
}));

export const productExternalIdRelations = relations(
  productExternalId,
  ({ one }) => ({
    product: one(product, {
      fields: [productExternalId.productId],
      references: [product.id],
    }),
  }),
);

export const productUnitMappingsRelations = relations(
  productUnitMappings,
  ({ one }) => ({
    product: one(product, {
      fields: [productUnitMappings.productId],
      references: [product.id],
    }),
  }),
);

export const productConversionCoverageRelations = relations(
  productConversionCoverage,
  ({ one }) => ({
    product: one(product, {
      fields: [productConversionCoverage.productId],
      references: [product.id],
    }),
  }),
);

export const locationRelations = relations(location, ({ one, many }) => ({
  parent: one(location, {
    fields: [location.parentId],
    references: [location.id],
    relationName: "LocationToLocation",
  }),
  children: many(location, {
    relationName: "LocationToLocation",
  }),
  inventoryEntries: many(inventoryEntry),
  images: many(locationImage),
  product: one(product, {
    fields: [location.productId],
    references: [product.id],
  }),
  plantings: many(planting),
  gardenEntries: many(gardenEntry),
}));

export const plantingRelations = relations(planting, ({ one, many }) => ({
  ingredient: one(ingredient, {
    fields: [planting.ingredientId],
    references: [ingredient.id],
  }),
  sourceProduct: one(product, {
    fields: [planting.sourceProductId],
    references: [product.id],
  }),
  location: one(location, {
    fields: [planting.locationId],
    references: [location.id],
  }),
  task: one(task, {
    fields: [planting.taskId],
    references: [task.id],
  }),
  entries: many(gardenEntryPlanting),
}));

export const gardenEntryRelations = relations(gardenEntry, ({ one, many }) => ({
  location: one(location, {
    fields: [gardenEntry.locationId],
    references: [location.id],
  }),
  plantings: many(gardenEntryPlanting),
  images: many(gardenEntryImage),
}));

export const gardenEntryPlantingRelations = relations(
  gardenEntryPlanting,
  ({ one }) => ({
    gardenEntry: one(gardenEntry, {
      fields: [gardenEntryPlanting.gardenEntryId],
      references: [gardenEntry.id],
    }),
    planting: one(planting, {
      fields: [gardenEntryPlanting.plantingId],
      references: [planting.id],
    }),
  }),
);

export const inventoryEntryRelations = relations(inventoryEntry, ({ one }) => ({
  owner: one(ledgerParty, {
    fields: [inventoryEntry.ownerLedgerPartyId],
    references: [ledgerParty.id],
  }),
  product: one(product, {
    fields: [inventoryEntry.productId],
    references: [product.id],
  }),
  location: one(location, {
    fields: [inventoryEntry.locationId],
    references: [location.id],
  }),
}));

export const imageRelations = relations(image, ({ many }) => ({
  productImages: many(productImage),
  locationImages: many(locationImage),
  recipeImages: many(recipeImage),
  projectImages: many(projectImage),
  purchaseImages: many(purchaseImage),
  gardenEntryImages: many(gardenEntryImage),
  mealImages: many(mealImage),
  taskImages: many(taskImage),
  cookbookCovers: many(cookbook),
  vendorLogos: many(vendor),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  tasks: many(task),
  expenses: many(expense),
  images: many(projectImage),
  toolUsages: many(projectToolUsage),
  parentProject: one(project, {
    fields: [project.parentProjectId],
    references: [project.id],
    relationName: "ProjectToProject",
  }),
  childProjects: many(project, {
    relationName: "ProjectToProject",
  }),
  blockedBy: many(projectDependency, { relationName: "ProjectBlocked" }),
  blocking: many(projectDependency, { relationName: "ProjectBlocking" }),
}));

export const projectToolUsageRelations = relations(
  projectToolUsage,
  ({ one }) => ({
    project: one(project, {
      fields: [projectToolUsage.projectId],
      references: [project.id],
    }),
    product: one(product, {
      fields: [projectToolUsage.productId],
      references: [product.id],
    }),
  }),
);

export const wishRelations = relations(wish, ({ many }) => ({
  candidates: many(wishCandidate),
}));

export const wishCandidateRelations = relations(wishCandidate, ({ one }) => ({
  wish: one(wish, {
    fields: [wishCandidate.wishId],
    references: [wish.id],
  }),
  product: one(product, {
    fields: [wishCandidate.productId],
    references: [product.id],
  }),
}));

export const projectDependencyRelations = relations(
  projectDependency,
  ({ one }) => ({
    project: one(project, {
      fields: [projectDependency.projectId],
      references: [project.id],
      relationName: "ProjectBlocked",
    }),
    blockedByProject: one(project, {
      fields: [projectDependency.blockedByProjectId],
      references: [project.id],
      relationName: "ProjectBlocking",
    }),
  }),
);

export const taskRelations = relations(task, ({ one, many }) => ({
  project: one(project, {
    fields: [task.projectId],
    references: [project.id],
  }),
  subjectProduct: one(product, {
    fields: [task.subjectProductId],
    references: [product.id],
  }),
  parentTask: one(task, {
    fields: [task.parentTaskId],
    references: [task.id],
    relationName: "TaskToTask",
  }),
  subtasks: many(task, {
    relationName: "TaskToTask",
  }),
  blockedBy: many(taskDependency, { relationName: "TaskBlocked" }),
  blocking: many(taskDependency, { relationName: "TaskBlocking" }),
  images: many(taskImage),
}));

export const taskDependencyRelations = relations(taskDependency, ({ one }) => ({
  task: one(task, {
    fields: [taskDependency.taskId],
    references: [task.id],
    relationName: "TaskBlocked",
  }),
  blockedByTask: one(task, {
    fields: [taskDependency.blockedByTaskId],
    references: [task.id],
    relationName: "TaskBlocking",
  }),
}));

export const expenseRelations = relations(expense, ({ one, many }) => ({
  purchase: one(purchase, {
    fields: [expense.purchaseId],
    references: [purchase.id],
  }),
  project: one(project, {
    fields: [expense.projectId],
    references: [project.id],
  }),
  product: one(product, {
    fields: [expense.productId],
    references: [product.id],
  }),
  attributions: many(expenseAttribution),
  sourceClaims: many(ledgerSourceClaim),
}));

export const ledgerPartyRelations = relations(ledgerParty, ({ many }) => ({
  accounts: many(financialAccount),
  attributions: many(expenseAttribution),
  mealRecipePortions: many(mealRecipePortion),
  outgoingTransfers: many(ledgerTransfer, {
    relationName: "LedgerTransferFromParty",
  }),
  incomingTransfers: many(ledgerTransfer, {
    relationName: "LedgerTransferToParty",
  }),
}));

export const expenseAttributionRelations = relations(
  expenseAttribution,
  ({ one }) => ({
    expense: one(expense, {
      fields: [expenseAttribution.expenseId],
      references: [expense.id],
    }),
    ledgerParty: one(ledgerParty, {
      fields: [expenseAttribution.ledgerPartyId],
      references: [ledgerParty.id],
    }),
  }),
);

export const ledgerSourceClaimRelations = relations(
  ledgerSourceClaim,
  ({ one }) => ({
    expense: one(expense, {
      fields: [ledgerSourceClaim.expenseId],
      references: [expense.id],
    }),
    ledgerTransfer: one(ledgerTransfer, {
      fields: [ledgerSourceClaim.ledgerTransferId],
      references: [ledgerTransfer.id],
    }),
  }),
);

export const vendorRelations = relations(vendor, ({ one, many }) => ({
  purchases: many(purchase),
  logo: one(image, {
    fields: [vendor.logoImageId],
    references: [image.id],
  }),
}));

export const financialAccountRelations = relations(
  financialAccount,
  ({ one, many }) => ({
    ledgerParty: one(ledgerParty, {
      fields: [financialAccount.ledgerPartyId],
      references: [ledgerParty.id],
    }),
    transactions: many(financialTransaction),
  }),
);

export const purchaseRelations = relations(purchase, ({ one, many }) => ({
  vendor: one(vendor, {
    fields: [purchase.vendorId],
    references: [vendor.id],
  }),
  expenses: many(expense),
  images: many(purchaseImage),
  products: many(purchaseProduct),
  settlementAllocations: many(financialTransactionAllocation),
}));

export const financialTransactionRelations = relations(
  financialTransaction,
  ({ one, many }) => ({
    account: one(financialAccount, {
      fields: [financialTransaction.accountId],
      references: [financialAccount.id],
    }),
    allocations: many(financialTransactionAllocation),
    ledgerTransfer: one(ledgerTransfer, {
      fields: [financialTransaction.ledgerTransferId],
      references: [ledgerTransfer.id],
    }),
  }),
);

export const financialTransactionAllocationRelations = relations(
  financialTransactionAllocation,
  ({ one }) => ({
    transaction: one(financialTransaction, {
      fields: [financialTransactionAllocation.transactionId],
      references: [financialTransaction.id],
    }),
    purchase: one(purchase, {
      fields: [financialTransactionAllocation.purchaseId],
      references: [purchase.id],
    }),
  }),
);

export const ledgerTransferRelations = relations(
  ledgerTransfer,
  ({ one, many }) => ({
    fromParty: one(ledgerParty, {
      fields: [ledgerTransfer.fromPartyId],
      references: [ledgerParty.id],
      relationName: "LedgerTransferFromParty",
    }),
    toParty: one(ledgerParty, {
      fields: [ledgerTransfer.toPartyId],
      references: [ledgerParty.id],
      relationName: "LedgerTransferToParty",
    }),
    evidenceTransactions: many(financialTransaction),
    sourceClaims: many(ledgerSourceClaim),
  }),
);

export const purchaseProductRelations = relations(
  purchaseProduct,
  ({ one }) => ({
    purchase: one(purchase, {
      fields: [purchaseProduct.purchaseId],
      references: [purchase.id],
    }),
    product: one(product, {
      fields: [purchaseProduct.productId],
      references: [product.id],
    }),
  }),
);

export const productComponentRelations = relations(
  productComponent,
  ({ one }) => ({
    parentProduct: one(product, {
      fields: [productComponent.parentProductId],
      references: [product.id],
      relationName: "productComponent_parentProduct",
    }),
    componentProduct: one(product, {
      fields: [productComponent.componentProductId],
      references: [product.id],
      relationName: "productComponent_componentProduct",
    }),
  }),
);

export const purchaseImageRelations = relations(purchaseImage, ({ one }) => ({
  purchase: one(purchase, {
    fields: [purchaseImage.purchaseId],
    references: [purchase.id],
  }),
  image: one(image, {
    fields: [purchaseImage.imageId],
    references: [image.id],
  }),
}));

export const projectImageRelations = relations(projectImage, ({ one }) => ({
  project: one(project, {
    fields: [projectImage.projectId],
    references: [project.id],
  }),
  image: one(image, {
    fields: [projectImage.imageId],
    references: [image.id],
  }),
}));

export const productImageRelations = relations(productImage, ({ one }) => ({
  product: one(product, {
    fields: [productImage.productId],
    references: [product.id],
  }),
  image: one(image, {
    fields: [productImage.imageId],
    references: [image.id],
  }),
}));

export const locationImageRelations = relations(locationImage, ({ one }) => ({
  location: one(location, {
    fields: [locationImage.locationId],
    references: [location.id],
  }),
  image: one(image, {
    fields: [locationImage.imageId],
    references: [image.id],
  }),
}));

export const gardenEntryImageRelations = relations(
  gardenEntryImage,
  ({ one }) => ({
    gardenEntry: one(gardenEntry, {
      fields: [gardenEntryImage.gardenEntryId],
      references: [gardenEntry.id],
    }),
    image: one(image, {
      fields: [gardenEntryImage.imageId],
      references: [image.id],
    }),
  }),
);

export const recipeImageRelations = relations(recipeImage, ({ one }) => ({
  recipe: one(recipe, {
    fields: [recipeImage.recipeId],
    references: [recipe.id],
  }),
  image: one(image, {
    fields: [recipeImage.imageId],
    references: [image.id],
  }),
}));

export const mealImageRelations = relations(mealImage, ({ one }) => ({
  meal: one(meal, {
    fields: [mealImage.mealId],
    references: [meal.id],
  }),
  image: one(image, {
    fields: [mealImage.imageId],
    references: [image.id],
  }),
}));

export const taskImageRelations = relations(taskImage, ({ one }) => ({
  task: one(task, {
    fields: [taskImage.taskId],
    references: [task.id],
  }),
  image: one(image, {
    fields: [taskImage.imageId],
    references: [image.id],
  }),
}));

export const aiAnalysis = pgTable(
  "AiAnalysis",
  {
    id: pkUuid(),
    entityType: text("entityType").notNull().$type<AiAnalysisEntityType>(),
    entityId: uuid("entityId"),
    feature: text("feature").notNull(),
    provider: text("provider"),
    resultSchemaRevision: integer("resultSchemaRevision"),
    runtime: jsonb("runtime").$type<AiAnalysisRuntime>(),
    model: text("model").notNull(),
    promptVersion: text("promptVersion").notNull(),
    inputFingerprint: text("inputFingerprint").notNull(),
    result: jsonb("result").notNull().$type<unknown>(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("AiAnalysis_active_key")
      .on(
        table.entityType,
        table.entityId,
        table.feature,
        table.model,
        table.promptVersion,
        table.inputFingerprint,
        sql`coalesce(${table.provider}, '')`,
        sql`coalesce(${table.resultSchemaRevision}, 0)`,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("AiAnalysis_entity_idx").on(table.entityType, table.entityId),
    index("AiAnalysis_feature_idx").on(table.feature),
  ],
);

export const aiUsage = pgTable(
  "AiUsage",
  {
    id: pkUuid(),
    feature: text("feature").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    jobKind: text("jobKind"),
    jobId: text("jobId"),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    cacheReadTokens: integer("cacheReadTokens"),
    cacheWriteTokens: integer("cacheWriteTokens"),
    attempt: integer("attempt").notNull().default(1),
    status: text("status")
      .notNull()
      .$type<"succeeded" | "failed">()
      .default("succeeded"),
    gatewayLogId: text("gatewayLogId"),
    estimatedCost: real("estimatedCost"),
    durationMs: integer("durationMs").notNull(),
    cacheStatus: text("cacheStatus").$type<"hit" | "miss" | "none">(),
    entityType: text("entityType"),
    entityId: uuid("entityId"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    ...softDeletedAt(),
  },
  (table) => [
    index("AiUsage_feature_createdAt_idx").on(
      table.feature,
      table.createdAt.desc(),
    ),
    index("AiUsage_model_createdAt_idx").on(
      table.model,
      table.createdAt.desc(),
    ),
    index("AiUsage_entity_idx").on(table.entityType, table.entityId),
    index("AiUsage_job_idx").on(table.jobKind, table.jobId),
  ],
);

// Durable, payload-free MCP usage events. The producer supplies the UUID so
// Cloudflare Queue retries are idempotent via ON CONFLICT DO NOTHING.
export const mcpToolCall = pgTable(
  "McpToolCall",
  {
    id: pkUuid(),
    toolName: text("toolName").notNull(),
    outcome: text("outcome").notNull().$type<McpToolCallOutcome>(),
    registeredAtCall: boolean("registeredAtCall").notNull(),
    surface: text("surface").notNull().$type<McpToolCallSurface>(),
    // Nullable: some tools span entities or have no entity at all, and old
    // payload-free events remain unattributable when the tool name alone is
    // ambiguous. Preserve null rather than guessing historical ownership.
    entity: text("entity").$type<Entity>(),
    release: text("release").notNull(),
    occurredAt: timestamp("occurredAt", { mode: "date" }).notNull(),
    ingestedAt: timestamp("ingestedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    userId: text("userId")
      .notNull()
      .$type<UserId>()
      .references(() => user.id),
    // Deliberately not an FK: revoking a dynamically registered OAuth client
    // deletes it, while historical usage must retain the caller identity.
    clientId: text("clientId"),
  },
  (table) => [
    index("McpToolCall_tool_occurredAt_idx").on(
      table.toolName,
      table.occurredAt.desc(),
    ),
    index("McpToolCall_user_occurredAt_idx").on(
      table.userId,
      table.occurredAt.desc(),
    ),
    index("McpToolCall_client_occurredAt_idx").on(
      table.clientId,
      table.occurredAt.desc(),
    ),
    index("McpToolCall_outcome_idx").on(table.outcome),
    index("McpToolCall_release_idx").on(table.release),
    index("McpToolCall_entity_occurredAt_idx").on(
      table.entity,
      table.occurredAt.desc(),
    ),
  ],
);

export const auditLog = pgTable(
  "AuditLog",
  {
    id: pkUuid(),
    entityType: text("entityType").notNull().$type<AuditEntityType>(),
    entityId: uuid("entityId").notNull(),
    action: text("action").notNull(), // 'create', 'update', 'delete'
    changes:
      jsonb("changes").$type<Record<string, { from: unknown; to: unknown }>>(),
    userId: text("userId")
      .notNull()
      .$type<UserId>()
      .references(() => user.id),
    // Deliberately plain text, not a pg enum: see `auditSourceSchema`, which
    // allows the application sources plus an open-ended `script:<slug>` for
    // one-off maintenance scripts. A DB-level enum would have made those writes
    // fail instead of the reads, which is worse — losing the row loses the
    // provenance this column exists to record.
    source: text("source").notNull().default("ui"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("AuditLog_createdAt_idx").on(table.createdAt.desc()),
    index("AuditLog_entityType_entityId_createdAt_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt.desc(),
    ),
  ],
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(user, {
    fields: [auditLog.userId],
    references: [user.id],
  }),
}));

type AppSettingValue =
  | string
  | number
  | boolean
  | null
  | AppSettingValue[]
  | { [key: string]: AppSettingValue };

export const appSettings = pgTable("AppSettings", {
  id: pkUuid(),
  metadata: jsonb("metadata").$type<Record<string, AppSettingValue>>(),
  ...baseTimestamps(),
});

/** Declare extension-owned views so drizzle-kit does not schedule unrecognized public-schema objects for DROP. */
export const pgStatStatements = pgView("pg_stat_statements", {
  // A representative column only: `.existing()` needs a shape, and since
  // Drizzle never creates or reads these, the shape is not verified against
  // the extension's real (and version-dependent) column list.
  query: text("query"),
}).existing();
export const pgStatStatementsInfo = pgView("pg_stat_statements_info", {
  dealloc: text("dealloc"),
}).existing();

export {
  imageDerivative,
  imageProcessingJob,
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingSubmission,
  imageProcessingSubmissionJob,
  imageDescriptionCorrection,
  imageProcessingOrphan,
} from "./image-processing-schema";
