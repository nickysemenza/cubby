import type { AiAnalysisEntityType } from "@cubby/schemas/ai";
import type { AuditEntityType } from "@cubby/schemas/audit";
import {
  type BackgroundBatchProcessor,
  type BackgroundBatchSource,
  type BackgroundBatchStatus,
  type BackgroundJobKind,
  type BackgroundJobStatus,
  backgroundJobKinds,
} from "@cubby/schemas/background-jobs";
import type { Amount } from "@cubby/schemas/codec";
import type { DataException } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity-core";
import {
  expenseLineBasisValues,
  expenseLineKindValues,
} from "@cubby/schemas/expense-line-kind";
import type {
  FinancialAccountIdentity,
  FinancialAccountSourceAlias,
} from "@cubby/schemas/financial-account";
import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction";
import type {
  CookbookId,
  ExpenseAttributionId,
  ExpenseId,
  FinancialAccountId,
  FinancialTransactionId,
  IngredientId,
  InventoryId,
  LedgerPartyId,
  LedgerTransferId,
  LocationId,
  MealId,
  MealRecipeId,
  ProductId,
  ProjectId,
  PurchaseId,
  RecipeId,
  TaskId,
  UserId,
  VendorId,
  WishId,
} from "@cubby/schemas/identifiers";
import { imageStatusValues } from "@cubby/schemas/image";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type {
  ContributionRole,
  LedgerPartyKind,
} from "@cubby/schemas/ledger-party";
import type { LedgerSourceClaimNormalizedEvidence } from "@cubby/schemas/ledger-transfer";
import type { LocationValuation } from "@cubby/schemas/location";
import {
  mealKindValues,
  mealTypeValues,
} from "@cubby/schemas/meal-classification";
import type { BaseKind } from "@cubby/schemas/problems";
import { productCategoryValues } from "@cubby/schemas/product";
import {
  costTypeValues,
  projectKindValues,
  projectStatusValues,
  taskStatusValues,
  tradeValues,
} from "@cubby/schemas/project";
import {
  type PurchaseDocumentKind,
  purchaseDocumentKindValues,
} from "@cubby/schemas/purchase";
import {
  type RecipeStoredMeta,
  type RecipeTotals,
  type RecipeYield,
  recipeSourceValues,
} from "@cubby/schemas/recipe-shared";
import type { SearchableEntity } from "@cubby/schemas/search";
import type {
  McpToolCallOutcome,
  McpToolCallSurface,
} from "@cubby/schemas/telemetry";
import { inventoryPlacementValues } from "@cubby/shared";
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
  pgEnum,
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
  oauthConsent,
  oauthRefreshToken,
  passkey,
  session,
  user,
  verification,
} from "./auth.schema";

export type { Amount };
export type Instruction = { text: string };

const pgVector = customType<{
  data: number[];
  driverData: string;
}>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .filter(Boolean)
      .map((v) => Number.parseFloat(v));
  },
});

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
  oauthConsent,
  oauthRefreshToken,
  passkey,
  session,
  user,
  verification,
};

export const recipeSourceEnum = pgEnum("RecipeSource", recipeSourceValues);
export const imageStatusEnum = pgEnum("ImageStatus", imageStatusValues);
export const inventoryPlacementEnum = pgEnum(
  "InventoryPlacement",
  inventoryPlacementValues,
);
export const imageRenderStatusEnum = pgEnum("ImageRenderStatus", [
  "unverified",
  "verified",
  "failed",
]);
export const imageStorageStatusEnum = pgEnum("ImageStorageStatus", [
  "unverified",
  "available",
  "missing",
  "metadata_mismatch",
]);

export const backgroundJobKindEnum = pgEnum(
  "BackgroundJobKind",
  backgroundJobKinds,
);

export const backgroundBatchStatusEnum = pgEnum("BackgroundBatchStatus", [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

export const backgroundJobStatusEnum = pgEnum("BackgroundJobStatus", [
  "pending",
  "queued",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
]);

export const backgroundBatchSourceEnum = pgEnum("BackgroundBatchSource", [
  "ui",
  "mutation",
  "backfill",
  "maintenance",
  "queue",
  "dev-inline",
]);

export const backgroundBatchProcessorEnum = pgEnum("BackgroundBatchProcessor", [
  "queue",
  "inline",
]);

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
const shortcodeColumn = () => text("shortcode").notNull();

/**
 * Uniqueness over the WHOLE table, soft-deleted rows included. That is the
 * point: a code must never be reused, so a deleted row's code stays a permanent
 * tombstone rather than becoming available again. These indexes were partial on
 * `deletedAt IS NULL` before the 2026-07 cutover, which had already let 269
 * codes be handed to a second entity.
 */
const shortcodeUnique = (tableName: string, column: AnyPgColumn) =>
  uniqueIndex(`${tableName}_shortcode_unique`).on(column);

export const recipe = pgTable(
  "Recipe",
  {
    id: pkUuid<RecipeId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
    SourceType: recipeSourceEnum("SourceType"),
    SourceData: text("SourceData"),
    cookbookId: uuid("cookbookId")
      .$type<CookbookId>()
      .references(() => cookbook.id),
    yield: jsonb("yield").$type<RecipeYield>(),
    servings: integer("servings"),
    tags: text("tags").array(),
    notes: text("notes"),
    // Precomputed cost/calorie rollup + when it was last computed. `null`
    // totalsComputedAt ⇒ stale (recomputed by the presence-driven drain). See
    // recipe-costing.service.
    totals: jsonb("totals").$type<RecipeTotals | null>(),
    totalsComputedAt: timestamp("totalsComputedAt", { mode: "date" }),
    // Import-carried times, split by what the list needs from SQL. These two are
    // real columns because "sort by total time" and "under 30 minutes" are list
    // membership and ordering — server work, never a React filter over fetched
    // rows. Null is genuinely unknown: the source printed no time, or printed
    // prose no parser would commit to a number for (see `meta.times` below).
    activeMinutes: integer("activeMinutes"),
    totalMinutes: integer("totalMinutes"),
    // Everything else the importers extract that nothing sorts by: the four
    // printed time strings, prep/cook minutes, special equipment, and the
    // printed page number (the cross-reference to a physical cookbook).
    // `meta.url` is deliberately NOT here — it stays derived from
    // SourceType/SourceData (see `dbRecipeToTopLevelShape`), so provenance keeps
    // one source of truth and this column needs no backfill.
    meta: jsonb("meta").$type<RecipeStoredMeta | null>(),
  },
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
  {
    id: pkUuid<CookbookId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    author: text("author")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subjects: text("subjects")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sourceLabel: text("sourceLabel").notNull(),
    rawJson: jsonb("rawJson").notNull().$type<ImportRecipe[]>(),
    coverImageId: uuid("coverImageId").references(() => image.id),
    // The physical copy on the shelf, when one is owned. Nullable: most
    // cookbooks are EPUB-only, and most shelf cookbooks were never imported.
    // The `AnyPgColumn` annotation is load-bearing, same as `Task.parentTaskId`
    // below: this FK closes a type-level cycle
    // (Cookbook → Product → Ingredient → Recipe → Cookbook), and without it
    // every table in the loop infers as `any` (TS7022).
    productId: uuid("productId")
      .$type<ProductId>()
      .references((): AnyPgColumn => product.id),
    importedAt: timestamp("importedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
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
  {
    id: pkUuid<IngredientId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Base measurement kinds the user has marked "not applicable" for this
    // ingredient (e.g. volume on whole lemons you only ever buy by count). The
    // coverage layer drops these from the graded universe so the ingredient can
    // read "complete" instead of being nagged for a gap it can't/shouldn't fill.
    // Read ONLY when building the `kinds` arg to conversionCoverage — never reaches
    // the conversion engine, so it can't affect costing.
    naKinds: text("naKinds")
      .array()
      .notNull()
      .$type<BaseKind[]>()
      .default(sql`'{}'::text[]`),
    ...baseTimestamps(),
    ...softDeletedAt(),
    recipeId: uuid("recipeId")
      .$type<RecipeId>()
      .references(() => recipe.id),
  },
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

export const meal = pgTable(
  "Meal",
  {
    id: pkUuid<MealId>(),
    shortcode: shortcodeColumn(),
    // Calendar day (no time/tz) — planning is day-granular. mode:"string" returns
    // a plain "YYYY-MM-DD"; a `date` read as a JS Date lands at UTC midnight and
    // misfilters by a day in negative-offset timezones. The Postgres column type
    // is unchanged (still `date`), so no migration is needed.
    date: date("date", { mode: "string" }).notNull(),
    name: text("name"),
    sortOrder: integer("sortOrder"),
    // Which eating occasion of the day. Nullable: a meal planned before this
    // column existed is genuinely unslotted, and defaulting it to "dinner"
    // would invent a fact. The planning calendar orders a day by declaration
    // order in mealTypeValues, unslotted last.
    mealType: text("mealType", { enum: mealTypeValues }),
    // How the meal is eaten. NOT NULL default "cooked" — true of every meal
    // that predates the column, so it's a real value rather than a stand-in
    // for "unknown". This is what distinguishes an intentionally recipe-less
    // meal (eating out) from one whose recipes just haven't been added yet;
    // both were always legal, neither was previously expressible. Only
    // "cooked" feeds the shopping list.
    mealKind: text("mealKind", { enum: mealKindValues })
      .notNull()
      .default("cooked"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("Meal", table.shortcode),
    index("Meal_date_active_idx")
      .on(table.date)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

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
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("MealRecipe_mealId_idx").on(table.mealId),
    index("MealRecipe_recipeId_idx").on(table.recipeId),
  ],
);

export const product = pgTable(
  "Product",
  {
    id: pkUuid<ProductId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    manufacturer: text("manufacturer").notNull(),
    // Explicit USDA link by FoodData Central id (the universal PK across all food
    // types). Takes precedence over UPC auto-resolution and can reach
    // Foundation/Survey foods that have no UPC or NDB number. Non-unique: many
    // products can share one reference food.
    fdc_id: integer("fdc_id"),
    model: text("model"),
    expectedQuantity: integer("expectedQuantity"),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
    ingredientId: uuid("ingredientId")
      .$type<IngredientId>()
      .references(() => ingredient.id),
    category: text("category", {
      enum: productCategoryValues,
    }),
    // Free-form compatibility/grouping tags, same convention as `recipe.tags`.
    // The point is class compatibility, which a product→product edge table
    // models badly: 3 angle grinders × 2 disc products would be 6 edges for one
    // fact, and 13 M18 tools would need 13 more for a battery. One shared tag
    // ("grinder-4.5in", "M18") on both the tool and the consumable does it, and
    // `category` (tools vs tool-consumables) already carries which side is which
    // — so the tag needs no direction of its own.
    // `notNull` + `'{}'` default follows `aliases` above rather than
    // `recipe.tags` (nullable), so the presence predicate is a plain
    // `cardinality(tags) = 0`. No GIN index: ~380 products, and every extra GIN
    // index widens the standing `db:push` drift for no measurable gain.
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Manual per-item valuation/replacement-price override. The effective price
    // falls back to the live Expense-derived unit cost when this is null; that
    // aggregate remains read-time so Expense stays the only historical-money
    // authority.
    price: real("price"),
    usdaUnavailable: boolean("usdaUnavailable"),
    stockTracked: boolean("stockTracked"),
    dataExceptions: jsonb("dataExceptions")
      .notNull()
      .$type<DataException[]>()
      .default([]),
  },
  (table) => [
    shortcodeUnique("Product", table.shortcode),
    index("Product_category_idx").on(table.category),
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
  {
    id: pkUuid<LocationId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...baseTimestamps(),
    ...softDeletedAt(),
    lastBulkInventory: timestamp("lastBulkInventory", { mode: "date" }),
    parentId: uuid("parentId")
      .$type<LocationId>()
      .references((): AnyPgColumn => location.id),
    // The SKU this location physically IS — "this bin is a Milwaukee
    // 48-22-8443". Many locations to one Product: the pooled model has no
    // per-unit identity, and only the count matters. Nullable because rooms,
    // areas and drawers are never something you buy.
    productId: uuid("productId")
      .$type<ProductId>()
      .references(() => product.id),
    // Nullable on purpose, and in practice mutually exclusive with productId:
    // form factor is a fact about the SKU, so a linked location leaves this
    // null rather than restating what the Product already says. Only
    // productless locations carry a type.
    type: text("type"),
    aiDescription: text("aiDescription"),
    // Precomputed inventory-valuation rollup (direct + descendants), recomputed
    // eagerly at inventory/price mutations — like recipe.totals. Null until the
    // first recompute. See location-valuation.service.
    valuation: jsonb("valuation").$type<LocationValuation | null>(),
  },
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
    check(
      "Location_productId_type_check",
      sql`${table.productId} IS NULL OR ${table.type} IS NULL`,
    ),
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
    embedding: pgVector("embedding").notNull(),
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
    // HNSW nearest-neighbor index. The column is untyped `vector` (dimensions
    // vary per model config row — prod uses 1536, tests seed 3), and pgvector
    // only indexes fixed-dimension expressions. So index the cast, and:
    //   1. findSemanticEntityCandidates must ORDER BY the same
    //      `embedding::vector(1536)` cast for the planner to use it, and
    //   2. the index is PARTIAL on `dimensions = 1536` — a non-partial index
    //      would evaluate `::vector(1536)` on every inserted row and throw
    //      "expected 1536 dimensions, not 3" on any smaller-dim row (the
    //      integration tests seed 3-dim vectors). Postgres skips the
    //      expression for rows failing the predicate, so those inserts pass.
    //      The query inlines a literal `dimensions = 1536` so the planner can
    //      prove the predicate and still use the index.
    index("EntityEmbedding_embedding_hnsw_idx")
      .using("hnsw", sql`(${table.embedding}::vector(1536)) vector_cosine_ops`)
      .where(sql`${table.deletedAt} IS NULL AND ${table.dimensions} = 1536`),
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
  {
    id: pkUuid<InventoryId>(),
    shortcode: shortcodeColumn(),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    amount: jsonb("amount").notNull().$type<Amount>(),
    ...baseTimestamps(),
    ...softDeletedAt(),
    locationId: uuid("locationId")
      .notNull()
      .$type<LocationId>()
      .references(() => location.id),
    // Precomputed: the amount routed to money through the Product's unit-mapping
    // graph (which carries a synthesized `1 each = $effectivePrice` edge), NOT
    // `amount.value × price`. Null when this unit has no path to money — either
    // the Product has no price, or it has one and this unit can't reach it.
    valuation: real("valuation"),
    // Durable record of when this entry was last verified in an audit session
    // (set on session "Done"). Nullable: null = never verified.
    verifiedAt: timestamp("verifiedAt", { mode: "date" }),
    // Movable stock vs a fixed installation — see `inventoryPlacementValues`
    // in @cubby/schemas/inventory for the full semantics. A pgEnum rather than
    // text + check(): `drizzle-kit push` does not diff CHECK constraints, so a
    // check here would exist in the test template (built via pushSchema) and
    // never in production.
    placement: inventoryPlacementEnum("placement").notNull().default("stock"),
  },
  (table) => [
    shortcodeUnique("InventoryEntry", table.shortcode),
    // Placement is part of the key so a spare on the shelf and one wired into
    // the wall can coexist in the same room — the normal state, not a duplicate.
    // Strictly more permissive than the old two-column form, so the CREATE can
    // never fail on existing data.
    uniqueIndex("InventoryEntry_productId_locationId_key")
      .on(table.productId, table.locationId, table.placement)
      .where(sql`${table.deletedAt} IS NULL`),
    index("InventoryEntry_productId_idx").on(table.productId),
    index("InventoryEntry_locationId_idx").on(table.locationId),
    index("InventoryEntry_createdAt_idx").on(table.createdAt),
  ],
);

export const image = pgTable(
  "Image",
  {
    id: pkUuid(),
    /** Public IMG- shortcode; every local-table entity has a public identifier. */
    shortcode: shortcodeColumn(),
    key: text("key").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    contentType: text("contentType").notNull(),
    status: imageStatusEnum("status").notNull().default("PENDING"),
    // Attachment integrity is intentionally nullable: browser presigned uploads
    // and legacy rows are verified later by the explicit verification path.
    width: integer("width"),
    height: integer("height"),
    detectedContentType: text("detectedContentType"),
    sha256: text("sha256"),
    renderStatus: imageRenderStatusEnum("renderStatus"),
    storageStatus: imageStorageStatusEnum("storageStatus"),
    verifiedAt: timestamp("verifiedAt", { mode: "date" }),
    // MCP attachment retries are scoped to a concrete gallery target. These
    // generic columns deliberately have no FK because Image may target five
    // different tables.
    targetType: text("targetType"),
    targetId: uuid("targetId"),
    idempotencyKey: text("idempotencyKey"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("Image", table.shortcode),
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
  ],
);

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
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("ProductImage_productId_imageId_key")
      .on(table.productId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ProductImage_productId_idx").on(table.productId),
    index("ProductImage_imageId_idx").on(table.imageId),
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

export const project = pgTable(
  "Project",
  {
    id: pkUuid<ProjectId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    status: text("status", { enum: projectStatusValues })
      .notNull()
      .default("planning"),
    kind: text("kind", { enum: projectKindValues }),
    locations: text("locations")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // double precision (not `real`): this is a dollar ledger — float4 loses
    // cents above ~$16k, which the import reconciliation actually caught.
    costEstimate: doublePrecision("costEstimate"),
    // Arbitrary-depth sub-projects (WBS) — a sub-project's own `costEstimate`
    // is its budget envelope; expenses/tasks attribute to it via their
    // existing `projectId`, not a new relation. Cycle/self-parent guards live
    // in repo/project/crud.ts (schema self-FK alone can't express "no cycle").
    parentProjectId: uuid("parentProjectId")
      .$type<ProjectId>()
      .references((): AnyPgColumn => project.id),
    startDate: date("startDate", { mode: "string" }),
    endDate: date("endDate", { mode: "string" }),
    icon: text("icon"),
    notes: text("notes"),
    googleDriveFolderUrl: text("googleDriveFolderUrl"),
    notionPageUrl: text("notionPageUrl"),
    // Source Notion page id (dashed uuid) — the import script's idempotency key.
    notionPageId: text("notionPageId"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
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

export const wish = pgTable(
  "Wish",
  {
    id: pkUuid<WishId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    notes: text("notes"),
    acquiredAt: timestamp("acquiredAt", { mode: "date" }),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("Wish", table.shortcode),
    index("Wish_createdAt_idx").on(table.createdAt),
    index("Wish_acquiredAt_idx").on(table.acquiredAt),
  ],
);

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
  {
    id: pkUuid<TaskId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    status: text("status", { enum: taskStatusValues })
      .notNull()
      .default("not_started"),
    projectId: uuid("projectId")
      .$type<ProjectId>()
      .references(() => project.id),
    subjectProductId: uuid("subjectProductId")
      .$type<ProductId>()
      .references(() => product.id),
    // One level of checklist subtasks — a subtask's own parentTaskId must be
    // null (enforced in repo/task/crud.ts, not the schema). Parent status
    // stays fully manual; an all-done checklist never auto-completes it.
    parentTaskId: uuid("parentTaskId")
      .$type<TaskId>()
      .references((): AnyPgColumn => task.id),
    dueDate: date("dueDate", { mode: "string" }),
    dueEndDate: date("dueEndDate", { mode: "string" }),
    trade: text("trade", { enum: tradeValues }).notNull(),
    // Board-only manual priority within a cell (drag-to-prioritize). Nullable:
    // ranked cards form a sparse "manual prefix", unranked cards keep the
    // derived (dueDate/name) order below them. Sparse doubles so an insert
    // between two ranks is a midpoint write (see board-model.ts computeRank);
    // NOT a table sort field. Double precision like cost/costEstimate.
    sortOrder: doublePrecision("sortOrder"),
    notionPageId: text("notionPageId"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
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
  {
    id: pkUuid<VendorId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    website: text("website"),
    logoImageId: uuid("logoImageId").references(() => image.id),
    /**
     * URL pattern for this vendor's own order-details page, with `{orderId}`
     * standing in for `Purchase.orderId` — e.g.
     * `https://www.amazon.com/gp/your-account/order-details?orderID={orderId}`.
     *
     * The per-purchase link is DERIVED from this at read time
     * (`purchaseOrderUrl`) rather than stored on every Purchase, the same way
     * an Amazon product link is derived from its ASIN rather than duplicated
     * into a column (`canonicalExternalIdUrl`). Vendor identity can't be
     * recovered from the name string, so this hangs off the vendor row.
     */
    orderUrlTemplate: text("orderUrlTemplate"),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("Vendor", table.shortcode),
    uniqueIndex("Vendor_name_key")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Vendor_logoImageId_idx").on(table.logoImageId),
  ],
);

/** A durable economic participant in the household ledger. */
export const ledgerParty = pgTable(
  "LedgerParty",
  {
    id: pkUuid<LedgerPartyId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    kind: text("kind").notNull().$type<LedgerPartyKind>(),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("LedgerParty", table.shortcode),
    index("LedgerParty_kind_idx").on(table.kind),
    uniqueIndex("LedgerParty_household_singleton_key")
      .on(table.kind)
      .where(sql`${table.deletedAt} IS NULL AND ${table.kind} = 'household'`),
    check(
      "LedgerParty_kind_check",
      sql`${table.kind} IN ('member', 'guest', 'household')`,
    ),
  ],
);

export const financialAccount = pgTable(
  "FinancialAccount",
  {
    id: pkUuid<FinancialAccountId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    identity: jsonb("identity").notNull().$type<FinancialAccountIdentity>(),
    provisional: boolean("provisional").notNull().default(false),
    sourceAliases: jsonb("sourceAliases")
      .notNull()
      .$type<FinancialAccountSourceAlias[]>()
      .default([]),
    ledgerPartyId: uuid("ledgerPartyId")
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("FinancialAccount", table.shortcode),
    index("FinancialAccount_name_idx").on(table.name),
    index("FinancialAccount_provisional_idx").on(table.provisional),
    index("FinancialAccount_ledgerPartyId_idx").on(table.ledgerPartyId),
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
    id: pkUuid<PurchaseId>(),
    shortcode: shortcodeColumn(),
    vendorId: uuid("vendorId")
      .notNull()
      .$type<VendorId>()
      .references(() => vendor.id),
    // The vendor's own order/receipt identifier. Free text — every retailer
    // formats these differently. Null on the ~40% of events where the vendor never
    // issued one for (a contractor's progress payment, a farmers-market run).
    orderId: text("orderId"),
    // Human-entered context from the original ledger, kept separate from the
    // vendor's immutable identity and rendered parenthetically in the title.
    displayLabel: text("displayLabel"),
    // The vendor order/receipt date. Distinct from `expense.date`, which stays the LEDGER date
    // driving monthly buckets and project date windows — an invoice dated the
    // 3rd can clear on the 8th.
    date: date("date", { mode: "string" }).notNull(),
    // The literal vendor-printed total. NEVER summed into spend and never
    // rewritten to match settlement; FinancialTransaction owns charges/refunds.
    statedTotal: doublePrecision("statedTotal"),
    notes: text("notes"),
    dataExceptions: jsonb("dataExceptions")
      .notNull()
      .$type<DataException[]>()
      .default([]),
    ...baseTimestamps(),
    ...softDeletedAt(),
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
    index("Purchase_vendorId_idx").on(table.vendorId),
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
  {
    id: pkUuid<FinancialTransactionId>(),
    shortcode: shortcodeColumn(),
    accountId: uuid("accountId")
      .notNull()
      .$type<FinancialAccountId>()
      .references(() => financialAccount.id),
    ledgerTransferId: uuid("ledgerTransferId")
      .$type<LedgerTransferId>()
      .references(() => ledgerTransfer.id),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    amount: doublePrecision("amount").notNull(),
    transactionDate: date("transactionDate", { mode: "string" }),
    postedDate: date("postedDate", { mode: "string" }),
    merchant: text("merchant"),
    rawDescription: text("rawDescription"),
    sourceCategory: text("sourceCategory"),
    sourceRefs: jsonb("sourceRefs")
      .notNull()
      .$type<FinancialTransactionSourceRef[]>()
      .default([]),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
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
  {
    id: pkUuid<LedgerTransferId>(),
    shortcode: shortcodeColumn(),
    fromPartyId: uuid("fromPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    toPartyId: uuid("toPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    amount: doublePrecision("amount").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    notes: text("notes"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
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
  {
    id: pkUuid<ExpenseId>(),
    shortcode: shortcodeColumn(),
    name: text("name").notNull(),
    // See project.costEstimate — dollars need double precision, not float4.
    cost: doublePrecision("cost"),
    date: date("date", { mode: "string" }).notNull(),
    lineKind: text("lineKind", { enum: expenseLineKindValues })
      .notNull()
      .default("principal"),
    // Is this row a line item, or a slice of a total that was never itemized?
    // `allocation` marks money cut by payment schedule (a deposit and a balance
    // on one order) or by an estimated materials/labor split of a lump-sum
    // contract. Such a row cannot carry a productId — the money doesn't
    // decompose per item — so it is correctly absent from the goods-without-a-
    // product worklists, and its costType may be an estimate rather than a
    // vendor-stated fact. See expenseLineBasisValues for the full contract.
    lineBasis: text("lineBasis", { enum: expenseLineBasisValues })
      .notNull()
      .default("item_line"),
    costType: text("costType", { enum: costTypeValues }).notNull(),
    trade: text("trade", { enum: tradeValues }).notNull(),
    url: text("url"),
    notes: text("notes"),
    // Planned/not-yet-made expense (kept out of spend rollups' "actuals" views).
    future: boolean("future").notNull().default(false),
    projectId: uuid("projectId")
      .$type<ProjectId>()
      .references(() => project.id),
    // Optional link to the thing this expense bought. Sparse by design: most
    // material runs stay unlinked, and only inventoried goods (tools, mainly)
    // get a product. A *negative* expense carrying the same productId is how
    // an exit is recorded — sale at sale price, return at full price, and a
    // broken/gifted item as cost 0 (never null: `cost IS NULL` is already the
    // Unclassified predicate) carrying a *negative* `productQuantity`. Net
    // cost, ownership window and owned/sold status are derived from these rows
    // plus inventory; nothing is stored.
    productId: uuid("productId")
      .$type<ProductId>()
      .references(() => product.id),
    // Optional signed product quantity: unknown is never guessed; settlement exits are represented as negative units.
    productQuantity: doublePrecision("productQuantity"),
    // The charge this line belongs to. Nullable: the 193 rows with no vendor
    // recorded have nothing to attach to, and forcing a synthetic charge on them
    // would invent a transaction that never happened. `vendor` and `orderId`
    // resolve THROUGH this join now — see `dbExpenseToAPI`.
    purchaseId: uuid("purchaseId")
      .$type<PurchaseId>()
      .references(() => purchase.id),
    notionPageId: text("notionPageId"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    shortcodeUnique("Expense", table.shortcode),
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
  product: many(product),
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
}));

export const mealRecipeRelations = relations(mealRecipe, ({ one }) => ({
  meal: one(meal, {
    fields: [mealRecipe.mealId],
    references: [meal.id],
  }),
  recipe: one(recipe, {
    fields: [mealRecipe.recipeId],
    references: [recipe.id],
  }),
}));

export const productRelations = relations(product, ({ one, many }) => ({
  ingredient: one(ingredient, {
    fields: [product.ingredientId],
    references: [ingredient.id],
  }),
  unitMappings: many(productUnitMappings),
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
}));

export const inventoryEntryRelations = relations(inventoryEntry, ({ one }) => ({
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

export const aiAnalysis = pgTable(
  "AiAnalysis",
  {
    id: pkUuid(),
    entityType: text("entityType").notNull().$type<AiAnalysisEntityType>(),
    entityId: uuid("entityId"),
    feature: text("feature").notNull(),
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
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    estimatedCost: real("estimatedCost"),
    durationMs: integer("durationMs").notNull(),
    cacheStatus: text("cacheStatus").$type<"hit" | "miss" | "none">(),
    entityType: text("entityType"),
    entityId: uuid("entityId"),
    batchId: uuid("batchId"),
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
    index("AiUsage_batch_idx").on(table.batchId),
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
    // Nullable: only derivable for CRUD-shaped tools (see mcpToolName inversion
    // in scripts/backfill-mcp-tool-call-entity.ts) plus attach/detach/merge,
    // which read it off an argument at the call site instead. Every other tool
    // family (find_*, patch_*, verify_*, statement/usda/problems workflows)
    // has no single entity to attribute a call to, so this stays null for them
    // rather than guessing.
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

export const backgroundBatch = pgTable(
  "BackgroundBatch",
  {
    id: pkUuid(),
    kind: backgroundJobKindEnum("kind").notNull().$type<BackgroundJobKind>(),
    // Durable workflow identity. Only active batches participate in the
    // partial unique index below, so a completed maintenance run remains
    // auditable while a later run may start normally.
    dedupeKey: text("dedupeKey"),
    source: backgroundBatchSourceEnum("source")
      .notNull()
      .$type<BackgroundBatchSource>(),
    processor: backgroundBatchProcessorEnum("processor")
      .notNull()
      .default("inline")
      .$type<BackgroundBatchProcessor>(),
    status: backgroundBatchStatusEnum("status")
      .notNull()
      .default("queued")
      .$type<BackgroundBatchStatus>(),
    totalJobs: integer("totalJobs").notNull().default(0),
    queuedJobs: integer("queuedJobs").notNull().default(0),
    runningJobs: integer("runningJobs").notNull().default(0),
    succeededJobs: integer("succeededJobs").notNull().default(0),
    failedJobs: integer("failedJobs").notNull().default(0),
    skippedJobs: integer("skippedJobs").notNull().default(0),
    cancelledJobs: integer("cancelledJobs").notNull().default(0),
    firstEnqueuedAt: timestamp("firstEnqueuedAt", { mode: "date" }),
    lastEnqueuedAt: timestamp("lastEnqueuedAt", { mode: "date" }),
    firstJobStartedAt: timestamp("firstJobStartedAt", { mode: "date" }),
    lastJobFinishedAt: timestamp("lastJobFinishedAt", { mode: "date" }),
    // bigint, not integer: int32 tops out at 2_147_483_647 ms = 24.86 days, and
    // these are wall-clock spans over a batch's whole life. A batch left open
    // longer than that (a lost queue wakeup strands one indefinitely) overflowed
    // the moment anything stamped finishedAt on its jobs, so the summary UPDATE
    // threw 22003 and rolled back the work that triggered it.
    processingDurationMs: bigint("processingDurationMs", { mode: "number" }),
    wallDurationMs: bigint("wallDurationMs", { mode: "number" }),
    activeDurationMs: bigint("activeDurationMs", { mode: "number" })
      .notNull()
      .default(0),
    metadata: jsonb("metadata").$type<unknown>(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("BackgroundBatch_status_idx").on(table.status),
    index("BackgroundBatch_kind_idx").on(table.kind),
    uniqueIndex("BackgroundBatch_active_dedupe_key")
      .on(table.kind, table.dedupeKey)
      .where(
        sql`${table.deletedAt} IS NULL AND ${table.dedupeKey} IS NOT NULL AND ${table.status} IN ('queued', 'running')`,
      ),
    index("BackgroundBatch_createdAt_idx").on(table.createdAt.desc()),
  ],
);

export const backgroundJob = pgTable(
  "BackgroundJob",
  {
    id: pkUuid(),
    batchId: uuid("batchId")
      .notNull()
      .references(() => backgroundBatch.id),
    kind: backgroundJobKindEnum("kind").notNull().$type<BackgroundJobKind>(),
    dedupeKey: text("dedupeKey").notNull(),
    payload: jsonb("payload").notNull().$type<unknown>(),
    status: backgroundJobStatusEnum("status")
      .notNull()
      .default("pending")
      .$type<BackgroundJobStatus>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(3),
    queuedAt: timestamp("queuedAt", { mode: "date" }),
    startedAt: timestamp("startedAt", { mode: "date" }),
    finishedAt: timestamp("finishedAt", { mode: "date" }),
    // bigint for the same reason as the batch spans above: a job whose worker
    // died holds `running` until the lease reclaims it, so now-startedAt can
    // exceed 24.86 days.
    durationMs: bigint("durationMs", { mode: "number" }),
    lastError: text("lastError"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    index("BackgroundJob_batch_idx").on(table.batchId),
    index("BackgroundJob_status_idx").on(table.status),
    index("BackgroundJob_kind_idx").on(table.kind),
    uniqueIndex("BackgroundJob_batch_dedupe_key")
      .on(table.batchId, table.dedupeKey)
      .where(sql`${table.deletedAt} IS NULL`),
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
