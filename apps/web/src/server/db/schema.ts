import type { AuditEntityType } from "@cubby/schemas/audit";
import type { Amount } from "@cubby/schemas/codec";
import type {
  CookbookId,
  IngredientId,
  InventoryId,
  LocationId,
  MealId,
  MealRecipeId,
  ProductId,
  RecipeId,
  UserId,
} from "@cubby/schemas/identifiers";
import { imageStatusValues } from "@cubby/schemas/image";
import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import type { LocationValuation } from "@cubby/schemas/location";
import type { BaseKind } from "@cubby/schemas/problems";
import { productCategoryValues } from "@cubby/schemas/product";
import {
  type RecipeTotals,
  type RecipeYield,
  recipeSourceValues,
} from "@cubby/schemas/recipe-shared";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  account,
  apikey,
  passkey,
  session,
  user,
  verification,
} from "./auth.schema";

// JSON types for JSONB columns
export type { Amount };
export type Instruction = { text: string };

// Re-export Better-Auth tables for use throughout the app
export { user, session, account, verification, apikey, passkey };

// Enums - values derived from Zod schemas
export const recipeSourceEnum = pgEnum("RecipeSource", recipeSourceValues);
export const imageStatusEnum = pgEnum("ImageStatus", imageStatusValues);

// Recipe table
export const recipe = pgTable(
  "Recipe",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<RecipeId>(),
    shortcode: text("shortcode"),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    SourceType: recipeSourceEnum("SourceType"),
    SourceData: text("SourceData"),
    // For Book recipes, the cookbook this came from. Nullable: Website/Other
    // recipes have no cookbook. SourceData is kept synced to the cookbook name
    // so the source codec stays a pure recipe-row read.
    cookbookId: uuid("cookbookId")
      .$type<CookbookId>()
      .references(() => cookbook.id),
    yield: jsonb("yield").$type<RecipeYield>(),
    servings: integer("servings"),
    tags: text("tags").array(),
    // Freeform markdown: headnote/intro blurb plus tips ("notes"). Imports
    // compose it from the source's description + notes; null when absent.
    notes: text("notes"),
    // Precomputed cost/calorie rollup + when it was last computed. `null`
    // totalsComputedAt ⇒ stale (recomputed by the presence-driven drain). See
    // recipe-costing.service.
    totals: jsonb("totals").$type<RecipeTotals | null>(),
    totalsComputedAt: timestamp("totalsComputedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("Recipe_shortcode_unique")
      .on(table.shortcode)
      .where(sql`${table.deletedAt} IS NULL`),
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
    index("Recipe_createdAt_idx").on(table.createdAt),
    index("Recipe_SourceType_idx").on(table.SourceType),
    index("Recipe_cookbookId_idx").on(table.cookbookId),
    // GIN index for full-text search on name
    index("Recipe_name_gin_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    index("Recipe_created_at_desc_idx").on(table.createdAt.desc()),
    // Partial index for soft delete queries
    index("Recipe_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    // Drain target: recipes whose totals need (re)computing.
    index("Recipe_totals_stale_idx")
      .on(table.totalsComputedAt)
      .where(sql`${table.totalsComputedAt} IS NULL`),
  ],
);

// Cookbook table — a first-class recipe source (the book a set of EPUB-extracted
// recipes came from). Holds the full assembled `ImportRecipe[]` JSON so recipes
// can be re-derived without re-running the LLM, plus OPF metadata. A cookbook is
// always born from a full import, so every content column is NOT NULL.
// Not linked to Product/inventory — the digital source and the physical book are
// deliberately separate (see plan: the EPUB set and the shelf don't overlap).
export const cookbook = pgTable(
  "Cookbook",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<CookbookId>(),
    name: text("name").notNull(),
    // EPUB OPF <dc:creator> / <dc:subject>; empty arrays when the book has none.
    author: text("author").array().notNull().default(sql`'{}'::text[]`),
    subjects: text("subjects").array().notNull().default(sql`'{}'::text[]`),
    // The EPUB `source` label (filename/path) from assembly.
    sourceLabel: text("sourceLabel").notNull(),
    // The full assembled extraction — powers reprocess-without-LLM.
    rawJson: jsonb("rawJson").notNull().$type<ImportRecipe[]>(),
    // The book's cover, extracted from the EPUB on import. Nullable: older
    // cookbooks / cover-less EPUBs have none.
    coverImageId: uuid("coverImageId").references(() => image.id),
    importedAt: timestamp("importedAt", { mode: "date" })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("Cookbook_name_key")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Cookbook_createdAt_idx").on(table.createdAt),
    index("Cookbook_coverImageId_idx").on(table.coverImageId),
    index("Cookbook_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
  ],
);

// RecipeSection table
export const recipeSection = pgTable(
  "RecipeSection",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    recipeId: uuid("recipeId")
      .notNull()
      .$type<RecipeId>()
      .references(() => recipe.id),
    name: text("name"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
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

// Ingredient table
export const ingredient = pgTable(
  "Ingredient",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<IngredientId>(),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
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
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    recipeId: uuid("recipeId")
      .$type<RecipeId>()
      .references(() => recipe.id),
  },
  (table) => [
    // Case-insensitive uniqueness: the matcher finds ingredients by lower(name)
    // (buildIngredientWhere), so the unique key must agree — otherwise "Flour"
    // and "flour" race past the matcher and both insert. The display value keeps
    // its original casing (first writer wins via ON CONFLICT); only the key is
    // lowercased. See findOrCreateIngredient's ON CONFLICT (lower(name)).
    uniqueIndex("Ingredient_name_key")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("Ingredient_recipeId_key")
      .on(table.recipeId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Ingredient_recipeId_idx").on(table.recipeId),
    index("Ingredient_createdAt_idx").on(table.createdAt),
    // GIN indexes for full-text search
    index("Ingredient_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    index("Ingredient_aliases_gin_idx").using("gin", table.aliases),
    // Partial index for soft delete queries
    index("Ingredient_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// RecipeSectionIngredient table
export const recipeSectionIngredient = pgTable(
  "RecipeSectionIngredient",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
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
    // Position within the section; see recipeSection.sortOrder for null semantics.
    sortOrder: integer("sortOrder"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    index("RecipeSectionIngredient_recipeSectionId_idx").on(
      table.recipeSectionId,
    ),
    index("RecipeSectionIngredient_ingredientId_idx").on(table.ingredientId),
  ],
);

// Meal table — a planned eating occasion on a calendar day. Groups one or more
// recipes (see mealRecipe). Multiple meals may share a date; an optional free-text
// name ("Dinner", "Sunday prep") and sortOrder distinguish/order them. Pure
// planning: no inventory mutation, no denormalized cost (rolled up read-time from
// recipe.totals × scale).
export const meal = pgTable(
  "Meal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`).$type<MealId>(),
    // Calendar day (no time/tz) — planning is day-granular. mode:"string" returns
    // a plain "YYYY-MM-DD"; a `date` read as a JS Date lands at UTC midnight and
    // misfilters by a day in negative-offset timezones. The Postgres column type
    // is unchanged (still `date`), so no migration is needed.
    date: date("date", { mode: "string" }).notNull(),
    name: text("name"),
    sortOrder: integer("sortOrder"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    // The calendar's range query (date BETWEEN from AND to) is the hot path.
    index("Meal_date_active_idx")
      .on(table.date)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// MealRecipe — a recipe planned into a meal at a numeric scale multiplier.
export const mealRecipe = pgTable(
  "MealRecipe",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<MealRecipeId>(),
    mealId: uuid("mealId")
      .notNull()
      .$type<MealId>()
      .references(() => meal.id),
    recipeId: uuid("recipeId")
      .notNull()
      .$type<RecipeId>()
      .references(() => recipe.id),
    // Scale multiplier (>= 0.01, enforced at the schema/router layer). Totals are
    // linear in this factor, so a meal's rollup is sum(recipe.totals × scale).
    scale: real("scale").notNull().default(1),
    sortOrder: integer("sortOrder"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    index("MealRecipe_mealId_idx").on(table.mealId),
    index("MealRecipe_recipeId_idx").on(table.recipeId),
  ],
);

// Product table
export const product = pgTable(
  "Product",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<ProductId>(),
    shortcode: text("shortcode").notNull(), // Human-readable ID (P-XXXX format)
    name: text("name").notNull(),
    manufacturer: text("manufacturer").notNull(),
    upc: text("upc"),
    // Explicit USDA link by FoodData Central id (the universal PK across all food
    // types). Takes precedence over UPC auto-resolution and can reach
    // Foundation/Survey foods that have no UPC or NDB number. Non-unique: many
    // products can share one reference food.
    fdc_id: integer("fdc_id"),
    model: text("model"),
    expectedQuantity: integer("expectedQuantity"),
    notes: text("notes"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    ingredientId: uuid("ingredientId")
      .$type<IngredientId>()
      .references(() => ingredient.id),
    category: text("category", {
      enum: productCategoryValues,
    }), // product category for filtering
    price: real("price"), // Unit price in dollars, null if no price mapping
    // Operator confirmed there's no USDA food for this product, so the coverage
    // fix stops suggesting a (futile) USDA link and expects manual entry of
    // weight/volume/calories instead. Does not suppress the problem — the card
    // stays flagged until those are filled manually.
    usdaUnavailable: boolean("usdaUnavailable"),
  },
  (table) => [
    uniqueIndex("Product_shortcode_unique")
      .on(table.shortcode)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Product_category_idx").on(table.category),
    uniqueIndex("Product_name_manufacturer_key")
      .on(table.name, table.manufacturer)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("Product_upc_key")
      .on(table.upc)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Product_ingredientId_idx").on(table.ingredientId),
    index("Product_createdAt_idx").on(table.createdAt),
    index("Product_name_idx").on(table.name),
    // GIN indexes for full-text search
    index("Product_name_gin_idx").using("gin", sql`${table.name} gin_trgm_ops`),
    index("Product_manufacturer_gin_idx").using(
      "gin",
      sql`${table.manufacturer} gin_trgm_ops`,
    ),
    index("Product_name_manufacturer_idx").on(table.name, table.manufacturer),
    // Partial indexes for soft delete queries
    index("Product_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Product_manufacturer_active_idx")
      .on(table.manufacturer)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// ProductExternalId table - generic external identifiers (Amazon ASIN, McMaster part number, etc.)
export const productExternalId = pgTable(
  "ProductExternalId",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    source: text("source").notNull(), // e.g. "amazon", "mcmaster", "mouser"
    externalId: text("externalId").notNull(), // The actual identifier (ASIN, part number, etc.)
    url: text("url"), // Optional direct link to the product page
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    index("ProductExternalId_productId_idx").on(table.productId),
    uniqueIndex("ProductExternalId_product_source_key")
      .on(table.productId, table.source)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// ProductUnitMappings table
export const productUnitMappings = pgTable(
  "ProductUnitMappings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    a: jsonb("a").notNull().$type<Amount>(),
    b: jsonb("b").notNull().$type<Amount>(),
    source: text("source"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [index("ProductUnitMappings_productId_idx").on(table.productId)],
);

// Location table
export const location = pgTable(
  "Location",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<LocationId>(),
    shortcode: text("shortcode").notNull(), // Human-readable ID (L-XXXX format)
    name: text("name").notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    lastBulkInventory: timestamp("lastBulkInventory", { mode: "date" }),
    parentId: uuid("parentId").$type<LocationId>(),
    type: text("type").notNull(),
    aiDescription: text("aiDescription"),
    // Precomputed inventory-valuation rollup (direct + descendants), recomputed
    // eagerly at inventory/price mutations — like recipe.totals. Null until the
    // first recompute. See location-valuation.service.
    valuation: jsonb("valuation").$type<LocationValuation | null>(),
  },
  (table) => [
    uniqueIndex("Location_shortcode_unique")
      .on(table.shortcode)
      .where(sql`${table.deletedAt} IS NULL`),
    // Case-insensitive uniqueness, matching the ilike lookup in
    // findOrCreateLocationByName (see Ingredient_name_key for the rationale).
    uniqueIndex("Location_name_key")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Location_name_idx").on(table.name),
    index("Location_type_idx").on(table.type),
    index("Location_parentId_idx").on(table.parentId),
    index("Location_createdAt_idx").on(table.createdAt),
    index("Location_lastBulkInventory_idx").on(table.lastBulkInventory),
    // GIN index for full-text search
    index("Location_name_gin_idx").using(
      "gin",
      sql`${table.name} gin_trgm_ops`,
    ),
    index("Location_type_name_idx").on(table.type, table.name),
    // Partial indexes for soft delete queries
    index("Location_name_active_idx")
      .on(table.name)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Location_type_active_idx")
      .on(table.type)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// InventoryEntry table
export const inventoryEntry = pgTable(
  "InventoryEntry",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`)
      .$type<InventoryId>(),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    amount: jsonb("amount").notNull().$type<Amount>(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
    locationId: uuid("locationId")
      .notNull()
      .$type<LocationId>()
      .references(() => location.id),
    valuation: real("valuation"), // Precomputed: amount.value * product.price
  },
  (table) => [
    uniqueIndex("InventoryEntry_productId_locationId_key")
      .on(table.productId, table.locationId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("InventoryEntry_productId_idx").on(table.productId),
    index("InventoryEntry_locationId_idx").on(table.locationId),
    index("InventoryEntry_createdAt_idx").on(table.createdAt),
  ],
);

// Image table
export const image = pgTable(
  "Image",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    url: text("url").notNull(),
    key: text("key").notNull(),
    filename: text("filename").notNull(),
    size: integer("size").notNull(),
    contentType: text("contentType").notNull(),
    status: imageStatusEnum("status").notNull().default("PENDING"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("Image_key_key")
      .on(table.key)
      .where(sql`${table.deletedAt} IS NULL`),
    index("Image_createdAt_idx").on(table.createdAt),
    index("Image_status_idx").on(table.status),
  ],
);

// ProductImage table
export const productImage = pgTable(
  "ProductImage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("ProductImage_productId_imageId_key")
      .on(table.productId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ProductImage_productId_idx").on(table.productId),
    index("ProductImage_imageId_idx").on(table.imageId),
  ],
);

// LocationImage table
export const locationImage = pgTable(
  "LocationImage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    locationId: uuid("locationId")
      .notNull()
      .$type<LocationId>()
      .references(() => location.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("LocationImage_locationId_imageId_key")
      .on(table.locationId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("LocationImage_locationId_idx").on(table.locationId),
    index("LocationImage_imageId_idx").on(table.imageId),
  ],
);

// RecipeImage table
export const recipeImage = pgTable(
  "RecipeImage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    recipeId: uuid("recipeId")
      .notNull()
      .$type<RecipeId>()
      .references(() => recipe.id),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("RecipeImage_recipeId_imageId_key")
      .on(table.recipeId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("RecipeImage_recipeId_idx").on(table.recipeId),
    index("RecipeImage_imageId_idx").on(table.imageId),
  ],
);

// Relations
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
  externalIds: many(productExternalId),
  inventoryEntry: many(inventoryEntry),
  images: many(productImage),
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

// Audit Log table
export const auditLog = pgTable(
  "AuditLog",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    entityType: text("entityType").notNull().$type<AuditEntityType>(),
    entityId: uuid("entityId").notNull(),
    action: text("action").notNull(), // 'create', 'update', 'delete'
    changes:
      jsonb("changes").$type<Record<string, { from: unknown; to: unknown }>>(),
    userId: text("userId")
      .notNull()
      .$type<UserId>()
      .references(() => user.id),
    source: text("source").notNull().default("ui"), // 'ui', 'csv_import', 'sheets_import', 'api'
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

// App Settings table - singleton table for app-wide configuration
export const appSettings = pgTable("AppSettings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updatedAt", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
