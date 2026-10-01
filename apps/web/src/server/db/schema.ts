import type {
  AiAnalysisEntityKind,
  AiAnalysisRuntime,
} from "@cubby/schemas/ai";
import type { AuditEntityKind, AuditFieldChange } from "@cubby/schemas/audit";
import type { Amount } from "@cubby/schemas/codec";
import type { AuditChannel } from "@cubby/schemas/context";
import {
  type EntityAttachmentRole,
  entityAttachmentRoleValues,
} from "@cubby/schemas/entity-attachment";
import type { Entity } from "@cubby/schemas/entity-core";
import type { EntityLinkKind } from "@cubby/schemas/entity-links";
import type { EntityExternalIdKind } from "@cubby/schemas/external-id";
import type {
  DeviceId,
  ExpenseAttributionId,
  ExpenseId,
  FinancialAccountId,
  FinancialTransactionId,
  ImageId,
  RunId,
  IngredientId,
  LedgerPartyId,
  LedgerTransferId,
  LocationId,
  MealId,
  MealFoodEntryId,
  MealRecipeId,
  MealRecipePortionId,
  ProductCategoryId,
  ProductId,
  PurchaseId,
  RecipeId,
  UserId,
  VendorId,
} from "@cubby/schemas/identifiers";
import type {
  ImageSightingCamera,
  ImageSightingLocation,
} from "@cubby/schemas/image-sighting-fields";
import type { ContributionRole } from "@cubby/schemas/ledger-party";
import type { LedgerSourceClaimNormalizedEvidence } from "@cubby/schemas/ledger-transfer";
import type { MealFoodNutrients } from "@cubby/schemas/meal";
import {
  type PurchaseDocumentKind,
  purchaseDocumentKindValues,
} from "@cubby/schemas/purchase";
import type { SearchableEntity } from "@cubby/schemas/search";
import type {
  McpToolCallOutcome,
  McpToolCallSurface,
} from "@cubby/schemas/telemetry";
import type { ShortcodeType } from "@cubby/shared";
import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
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
import { entityIdentity } from "./entity-identity-schema";
import {
  entityLinkKindCheckSql,
  entityLinkNoSelfCheckSql,
  entityLinkQuantityCheckSql,
} from "./entity-link-schema";
import {
  externalIdKindCheckSql,
  externalIdPrimaryCheckSql,
} from "./external-id-schema";
import {
  cookbook,
  device,
  expense,
  financialAccount,
  financialTransaction,
  gardenEntry,
  image,
  ingredient,
  ledgerParty,
  ledgerTransfer,
  location,
  meal,
  product,
  productCategory,
  project,
  purchase,
  recipe,
  run,
  task,
  vendor,
  vendorAccount,
} from "./generated/entity-tables.gen";

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

const entityIdColumn = () => uuid("entityId");
const entityKindColumn = <K extends string>() => text("entityKind").$type<K>();

interface EntityRefOptions<K extends string> {
  nullable: boolean;
  /** Type-level narrowing of `entityKind`; the table's own CHECK enforces it. */
  kinds?: readonly K[];
}
interface RequiredEntityRef<K extends string> {
  entityId: ReturnType<ReturnType<typeof entityIdColumn>["notNull"]>;
  entityKind: ReturnType<ReturnType<typeof entityKindColumn<K>>["notNull"]>;
}
interface NullableEntityRef<K extends string> {
  entityId: ReturnType<typeof entityIdColumn>;
  entityKind: ReturnType<typeof entityKindColumn<K>>;
}

/**
 * The one shape of "a column that points at any entity": `entityId`
 * (`Entity.id`) plus the `entityKind` stored beside it. Every such table binds
 * the pair to `Entity(id, kind)` with `entityRefFk`, so a row cannot name an
 * entity of a kind it is not. A nullable ref (an AI call with no subject)
 * passes the composite FK by MATCH SIMPLE while either half is null.
 */
function entityRef<K extends string = ShortcodeType>(
  options: EntityRefOptions<K> & { nullable: false },
): RequiredEntityRef<K>;
function entityRef<K extends string = ShortcodeType>(
  options: EntityRefOptions<K> & { nullable: true },
): NullableEntityRef<K>;
function entityRef<K extends string>(
  options: EntityRefOptions<K>,
): RequiredEntityRef<K> | NullableEntityRef<K> {
  return options.nullable
    ? { entityId: entityIdColumn(), entityKind: entityKindColumn<K>() }
    : {
        entityId: entityIdColumn().notNull(),
        entityKind: entityKindColumn<K>().notNull(),
      };
}

/** The composite-FK half of `entityRef`; each table keeps its own name. */
const entityRefFk = (
  name: string,
  table: { entityId: AnyPgColumn; entityKind: AnyPgColumn },
) =>
  foreignKey({
    name,
    columns: [table.entityId, table.entityKind],
    foreignColumns: [entityIdentity.id, entityIdentity.kind],
  });

/**
 * The `{ value, unit }` amount stored as two columns. Both null (an absent
 * optional amount) or both set with a positive finite value and a trimmed,
 * non-empty unit.
 */
const validAmountColumns = (value: AnyPgColumn, unit: AnyPgColumn) => sql`
  (${value} IS NULL AND ${unit} IS NULL) OR (
    ${value} IS NOT NULL AND ${unit} IS NOT NULL
    AND ${value} > 0 AND ${value} < 'Infinity'::double precision
    AND length(trim(${unit})) > 0 AND ${unit} = trim(${unit})
  )
`;

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
    amountValue: doublePrecision("amountValue").notNull(),
    amountUnit: text("amountUnit").notNull(),
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
      "MealRecipePortion_amount_check",
      validAmountColumns(table.amountValue, table.amountUnit),
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
    amountValue: doublePrecision("amountValue"),
    amountUnit: text("amountUnit"),
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
      "MealFoodEntry_amount_check",
      validAmountColumns(table.amountValue, table.amountUnit),
    ),
    check(
      "MealFoodEntry_source_check",
      sql`(${table.sourceKind} = 'ingredient' AND ${table.ingredientId} IS NOT NULL AND ${table.productId} IS NULL AND ${table.amountValue} IS NOT NULL AND ${table.name} IS NULL AND ${table.nutrients} IS NULL) OR (${table.sourceKind} = 'product' AND ${table.ingredientId} IS NULL AND ${table.productId} IS NOT NULL AND ${table.amountValue} IS NOT NULL AND ${table.name} IS NULL AND ${table.nutrients} IS NULL) OR (${table.sourceKind} = 'manual' AND ${table.ingredientId} IS NULL AND ${table.productId} IS NULL AND length(trim(${table.name})) > 0 AND ${table.name} IS NOT NULL AND ${table.nutrients} IS NOT NULL AND jsonb_typeof(${table.nutrients}) = 'object' AND ${table.nutrients} <> '{}'::jsonb)`,
    ),
  ],
);

export {
  entityIdentity,
  entityIdentityRelations,
} from "./entity-identity-schema";
// Entity tables + relations are generated from their declarations
// (`packages/schemas/src/entity-definitions/*.entity.ts`, `storage`).
export * from "./generated/entity-tables.gen";

export const productUnitMappings = pgTable(
  "ProductUnitMapping",
  {
    id: pkUuid(),
    productId: uuid("productId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    aValue: doublePrecision("aValue").notNull(),
    aUnit: text("aUnit").notNull(),
    bValue: doublePrecision("bValue").notNull(),
    bUnit: text("bUnit").notNull(),
    source: text("source"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [index("ProductUnitMapping_productId_idx").on(table.productId)],
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
 * `status=ready` includes a provider miss (`name` null): it is a successfully
 * checked UPC with no useful fields, not an outage. Provider outages deliberately do not
 * overwrite a previous answer, so callers can distinguish stale data from an
 * unavailable provider.
 */
export const upcLookupCache = pgTable(
  "UpcLookupCache",
  {
    upc: text("upc").primaryKey(),
    /** Null on a checked miss; `manual` rows (hand-entered) are never refreshed. */
    name: text("name"),
    manufacturer: text("manufacturer"),
    brand: text("brand"),
    category: text("category"),
    description: text("description"),
    priceDollars: doublePrecision("priceDollars"),
    imageUrl: text("imageUrl"),
    /** `manual` | `upcitemdb`; see UPC_SOURCE_NAMES. */
    source: text("source").notNull().default("upcitemdb"),
    status: text("status").notNull().default("ready"),
    fetchedAt: timestamp("fetchedAt", { mode: "date" }).notNull(),
  },
  (table) => [
    index("UpcLookupCache_fetchedAt_idx").on(table.fetchedAt),
    index("UpcLookupCache_status_idx").on(table.status),
  ],
);

export const entityEmbedding = pgTable(
  "EntityEmbedding",
  {
    id: pkUuid(),
    ...entityRef<SearchableEntity>({ nullable: false }),
    embeddingText: text("embeddingText").notNull(),
    embeddingHash: text("embeddingHash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    // A rebuildable projection of one live identity (ADR 0006).
    entityRefFk("EntityEmbedding_entity_fk", table),
    uniqueIndex("EntityEmbedding_entity_model_key")
      .on(
        table.entityKind,
        table.entityId,
        table.provider,
        table.model,
        table.dimensions,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("EntityEmbedding_entity_idx").on(table.entityKind, table.entityId),
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
    ...entityRef<SearchableEntity>({ nullable: false }),
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
    // A rebuildable projection of one live identity (ADR 0006).
    entityRefFk("SearchDocument_entity_fk", table),
    uniqueIndex("SearchDocument_live_entity_key")
      .on(table.entityKind, table.entityId)
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
    ...entityRef<SearchableEntity>({ nullable: false }),
    suggestionKind: text("suggestionKind").notNull(),
    candidateKey: text("candidateKey").notNull(),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    uniqueIndex("SuggestionDismissal_active_key")
      .on(
        table.entityKind,
        table.entityId,
        table.suggestionKind,
        table.candidateKey,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("SuggestionDismissal_source_idx").on(
      table.entityKind,
      table.entityId,
    ),
    entityRefFk("SuggestionDismissal_entity_fk", table),
  ],
);

/**
 * A reviewed or agent-proposed "same real item" pair of Products — the one
 * durable half of the product match queue (the detector's own pairs are
 * recomputed live and only land here once dismissed).
 *
 * Hard-delete-only review metadata: deleting or merging away either Product
 * discards the row (see the product delete/merge edge policies), so a merged
 * pair can never survive as a self-pair. The pair is stored canonically
 * (`productAId < productBId`) so re-proposing in either order hits the same
 * row.
 */
export const productMatchCandidate = pgTable(
  "ProductMatchCandidate",
  {
    id: pkUuid(),
    productAId: uuid("productAId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    productBId: uuid("productBId")
      .notNull()
      .$type<ProductId>()
      .references(() => product.id),
    source: text("source").notNull().$type<"agent" | "detector">(),
    state: text("state").notNull().$type<"open" | "dismissed">(),
    evidence: text("evidence"),
    sourceUrls: text("sourceUrls")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("ProductMatchCandidate_pair_key").on(
      table.productAId,
      table.productBId,
    ),
    index("ProductMatchCandidate_productB_idx").on(table.productBId),
    check(
      "ProductMatchCandidate_canonical_pair_check",
      sql`${table.productAId} < ${table.productBId}`,
    ),
    check(
      "ProductMatchCandidate_source_check",
      sql`${table.source} IN ('agent', 'detector')`,
    ),
    check(
      "ProductMatchCandidate_state_check",
      sql`${table.state} IN ('open', 'dismissed')`,
    ),
  ],
);

/**
 * A reasoned, evidence-bound "this gap does not apply" for one data-quality
 * check on one entity (ADR 0006). Replaces the per-table `dataExceptions`
 * jsonb columns so any exception-capable entity can record one. The
 * fingerprint is the check's evidence signature when the exception was set;
 * any evidence change makes it stale.
 */
export const dataExceptionRecord = pgTable(
  "DataException",
  {
    id: pkUuid(),
    ...entityRef<string>({ nullable: false }),
    check: text("check").notNull(),
    reason: text("reason").notNull(),
    note: text("note").notNull(),
    fingerprint: text("fingerprint"),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("DataException_entity_check_key").on(
      table.entityId,
      table.check,
    ),
    entityRefFk("DataException_entity_fk", table),
  ],
);

/**
 * Every direct file association, for every entity (ADR 0006). Replaces the
 * per-entity gallery joins and the cookbook cover / vendor logo columns.
 *
 * `role` follows the subject kind's declared image storage: gallery entities
 * hold `attachment` rows, a cookbook one `cover`, a vendor one `logo`.
 * `purpose` is Product-only and `documentKind` Purchase-only, enforced by
 * CHECKs on the stored `entityKind`.
 *
 * Detach soft-deletes. Upload idempotency lives here rather than on `Image`,
 * so a key reuses a file only while that exact association is active.
 */
export const entityAttachment = pgTable(
  "EntityAttachment",
  {
    id: pkUuid(),
    ...entityRef({ nullable: false }),
    imageId: uuid("imageId")
      .notNull()
      .references(() => image.id),
    role: text("role", { enum: entityAttachmentRoleValues })
      .notNull()
      .default("attachment")
      .$type<EntityAttachmentRole>(),
    // Display order; 0 default means legacy rows tie-break on createdAt.
    sortOrder: integer("sortOrder").notNull().default(0),
    // `null` is the legacy item role and deliberately remains displayable.
    purpose: text("purpose", { enum: ["item", "label"] as const }),
    documentKind: text("documentKind", {
      enum: purchaseDocumentKindValues,
    }).$type<PurchaseDocumentKind>(),
    idempotencyKey: text("idempotencyKey"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    entityRefFk("EntityAttachment_entity_fk", table),
    uniqueIndex("EntityAttachment_entity_image_key")
      .on(table.entityId, table.imageId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("EntityAttachment_entity_singular_role_key")
      .on(table.entityId, table.role)
      .where(
        sql`${table.role} IN ('cover', 'logo') AND ${table.deletedAt} IS NULL`,
      ),
    uniqueIndex("EntityAttachment_entity_idempotency_key")
      .on(table.entityId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} IS NOT NULL AND ${table.deletedAt} IS NULL`,
      ),
    index("EntityAttachment_entity_order_idx").on(
      table.entityId,
      table.sortOrder,
    ),
    index("EntityAttachment_imageId_idx").on(table.imageId),
    check(
      "EntityAttachment_role_check",
      sql`${table.role} IN ('attachment', 'cover', 'logo')`,
    ),
    check(
      "EntityAttachment_purpose_check",
      sql`${table.purpose} IS NULL OR ${table.purpose} IN ('item', 'label')`,
    ),
    check(
      "EntityAttachment_purpose_kind_check",
      sql`${table.purpose} IS NULL OR ${table.entityKind} = 'product'`,
    ),
    check(
      "EntityAttachment_documentKind_kind_check",
      sql`${table.documentKind} IS NULL OR ${table.entityKind} = 'purchase'`,
    ),
  ],
);

/** A cultivar or species the household sows or buys as a transplant. */
/**
 * Every many-to-many relationship between two entities (ADR 0007): a kit's
 * components, an order's products, a project's tools, a garden entry's
 * plantings, a wish's candidates, and task/project dependencies. Kinds and
 * their endpoint kinds are declared once in `@cubby/schemas/entity-links`;
 * the CHECKs below are rendered from that map (`entity-link-schema.ts`), and
 * the derived-DDL trigger refuses a live link to a deleted entity.
 *
 * `from` is the owning side (the kit, the blocked task, the order). Links
 * soft-delete; the partial pair key lets a detached pair be re-attached.
 */
export const entityLink = pgTable(
  "EntityLink",
  {
    id: pkUuid(),
    kind: text("kind").notNull().$type<EntityLinkKind>(),
    fromEntityId: uuid("fromEntityId").notNull(),
    fromKind: text("fromKind").notNull().$type<Entity>(),
    toEntityId: uuid("toEntityId").notNull(),
    toKind: text("toKind").notNull().$type<Entity>(),
    quantity: integer("quantity"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    foreignKey({
      name: "EntityLink_from_fk",
      columns: [table.fromEntityId, table.fromKind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }),
    foreignKey({
      name: "EntityLink_to_fk",
      columns: [table.toEntityId, table.toKind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }),
    check("EntityLink_kind_check", sql.raw(entityLinkKindCheckSql())),
    check("EntityLink_quantity_check", sql.raw(entityLinkQuantityCheckSql())),
    check("EntityLink_no_self_check", sql.raw(entityLinkNoSelfCheckSql())),
    uniqueIndex("EntityLink_kind_from_to_key")
      .on(table.kind, table.fromEntityId, table.toEntityId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("EntityLink_to_kind_idx")
      .on(table.toEntityId, table.kind)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

/**
 * The registry of places an identifier can come from: a vendor's catalog
 * (`amazon`), a provider export (`monarch`), or a system (`notion`). Every
 * `EntityExternalId.source`, statement import, statement row, and ledger claim
 * names one, so a slug is spelled once. `vendorId` names the Vendor the slug
 * is, when it is one.
 */
export const externalSource = pgTable(
  "ExternalSource",
  {
    slug: text("slug").primaryKey(),
    label: text("label").notNull(),
    vendorId: uuid("vendorId")
      .$type<VendorId>()
      .references(() => vendor.id),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "ExternalSource_slug_check",
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
  ],
);

/**
 * Every identifier an outside system gives an entity: a product's ASIN or
 * barcode, a settlement's order reference, a task's Notion page. Kinds and the
 * entities they attach to are declared in `EXTERNAL_ID_KINDS`; the CHECKs are
 * rendered from it (`external-id-schema.ts`).
 *
 * An identifier names at most one live entity (`source, kind, externalId`),
 * which is what makes collision detection and statement matching exact. Rows
 * soft-delete with their entity, so a re-import after a delete can claim the
 * identifier again.
 */
export const entityExternalId = pgTable(
  "EntityExternalId",
  {
    id: pkUuid(),
    ...entityRef({ nullable: false }),
    source: text("source")
      .notNull()
      .references(() => externalSource.slug, { onUpdate: "cascade" }),
    kind: text("kind").notNull().$type<EntityExternalIdKind>(),
    externalId: text("externalId").notNull(),
    url: text("url"),
    /** The value that stands for its `(entity, source, kind)` slot; NULL for slotless kinds. */
    isPrimary: boolean("isPrimary"),
    ...baseTimestamps(),
    ...softDeletedAt(),
  },
  (table) => [
    entityRefFk("EntityExternalId_entity_fk", table),
    check("EntityExternalId_kind_check", sql.raw(externalIdKindCheckSql())),
    check(
      "EntityExternalId_primary_check",
      sql.raw(externalIdPrimaryCheckSql()),
    ),
    // Barcodes are stored in ONE canonical encoding (GTIN-14): Postgres
    // `lpad` truncates longer input, so the format is a constraint, not a
    // convention.
    check(
      "EntityExternalId_gtin_check",
      sql`${table.kind} <> 'gtin_14' OR ${table.externalId} ~ '^[0-9]{14}$'`,
    ),
    uniqueIndex("EntityExternalId_source_kind_externalId_key")
      .on(table.source, table.kind, table.externalId)
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex("EntityExternalId_entity_source_kind_primary_key")
      .on(table.entityId, table.source, table.kind)
      .where(sql`${table.isPrimary} AND ${table.deletedAt} IS NULL`),
    index("EntityExternalId_entityId_idx").on(table.entityId),
  ],
);

/** One report of a stored Image appearing in a member's photo library or
 * cloud asset; see ADR 0005. A child of its Image, not an entity: it has no
 * shortcode or identity row, and its audit history lives on the Image. */
export const imageSighting = pgTable(
  "ImageSighting",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    imageId: uuid("imageId")
      .notNull()
      .references((): AnyPgColumn => image.id, { onDelete: "cascade" }),
    ledgerPartyId: uuid("ledgerPartyId")
      .$type<LedgerPartyId>()
      .notNull()
      .references((): AnyPgColumn => ledgerParty.id),
    deviceId: uuid("deviceId")
      .$type<DeviceId>()
      .notNull()
      .references((): AnyPgColumn => device.id),
    assetKey: text("assetKey").notNull(),
    cloudIdentifier: text("cloudIdentifier"),
    localIdentifier: text("localIdentifier"),
    sourceType: text("sourceType", {
      enum: ["userLibrary", "cloudShared", "iTunesSynced"],
    }).notNull(),
    mediaSubtypes: text("mediaSubtypes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    originalFilename: text("originalFilename"),
    pixelWidth: integer("pixelWidth"),
    pixelHeight: integer("pixelHeight"),
    hasAdjustments: boolean("hasAdjustments").notNull().default(false),
    capturedAt: timestamp("capturedAt", { mode: "date" }),
    capturedAtOffsetMinutes: integer("capturedAtOffsetMinutes"),
    addedAt: timestamp("addedAt", { mode: "date" }),
    location: jsonb("location").$type<ImageSightingLocation | null>(),
    placeName: text("placeName"),
    camera: jsonb("camera").$type<ImageSightingCamera | null>(),
    matchKind: text("matchKind", {
      enum: ["import", "libraryMatch"],
    }).notNull(),
    hashDistance: integer("hashDistance"),
    aspectGate: boolean("aspectGate"),
    observedAt: timestamp("observedAt", { mode: "date" }).notNull(),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deletedAt", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("ImageSighting_image_party_asset_key")
      .on(table.imageId, table.ledgerPartyId, table.assetKey)
      .where(sql`${table.deletedAt} IS NULL`),
    index("ImageSighting_imageId_idx").on(table.imageId),
    index("ImageSighting_ledgerPartyId_idx").on(table.ledgerPartyId),
    index("ImageSighting_deviceId_idx").on(table.deviceId),
    check(
      "ImageSighting_sourceType_check",
      sql`${table.sourceType} IN ('userLibrary', 'cloudShared', 'iTunesSynced')`,
    ),
    check(
      "ImageSighting_matchKind_check",
      sql`${table.matchKind} IN ('import', 'libraryMatch')`,
    ),
  ],
);

const runTargetKinds = ["purchase", "product", "image"] as const;

/**
 * Explicit no-op-validation/enrichment targets; the Run's writes are
 * AuditLog rows carrying its `runId`. A target names a purchase, product or image by `entityRef`;
 * the composite FK targets `Entity`, whose rows outlive a hard delete, so a
 * target keeps its tombstone the way the old Purchase FK's policy asked.
 */
export const runTarget = pgTable(
  "RunTarget",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
    ...entityRef({ nullable: false, kinds: runTargetKinds }),
    /** Picker order within a photo-inventory run; the tiebreak when capture times collide. */
    position: integer("position"),
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
    /**
     * Device-side processing state for a photo-run image target, reported by
     * `run.reportDeviceWork`. Null means no device has picked up this photo
     * yet; distinct from `state` (the server-side prepare/complete pipeline).
     */
    deviceWorkState:
      text("deviceWorkState").$type<
        import("@cubby/schemas/photo-import-run").RunTargetDeviceWorkState
      >(),
    deviceWorkAttempts: integer("deviceWorkAttempts").notNull().default(0),
    deviceWorkError: text("deviceWorkError"),
    deviceWorkDeviceId: uuid("deviceWorkDeviceId")
      .$type<DeviceId>()
      .references(() => device.id, { onDelete: "set null" }),
    deviceWorkUpdatedAt: timestamp("deviceWorkUpdatedAt", { mode: "date" }),
    ...baseTimestamps(),
  },
  (table) => [
    index("RunTarget_run_idx").on(table.runId),
    // The target's own lookups (product/purchase/image merge and delete).
    index("RunTarget_entity_idx").on(table.entityId),
    entityRefFk("RunTarget_entity_fk", table),
    index("RunTarget_deviceWorkDeviceId_idx")
      .on(table.deviceWorkDeviceId)
      .where(sql`${table.deviceWorkDeviceId} IS NOT NULL`),
    uniqueIndex("RunTarget_run_entity_key").on(table.runId, table.entityId),
    check(
      "RunTarget_entityKind_check",
      sql`${table.entityKind} IN (${sql.join(
        runTargetKinds.map((kind) => sql.raw(`'${kind}'`)),
        sql`, `,
      )})`,
    ),
    check(
      "RunTarget_state_check",
      sql`${table.state} IN ('pending', 'prepared', 'completed', 'skipped', 'unresolved', 'needs_evidence', 'unavailable')`,
    ),
    check(
      "RunTarget_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('replayed', 'raw_evidence_drift', 'semantic_drift', 'enriched', 'unavailable', 'skipped', 'attached')`,
    ),
    check(
      "RunTarget_deviceWorkState_check",
      sql`${table.deviceWorkState} IS NULL OR ${table.deviceWorkState} IN ('queued', 'running', 'paused', 'failed', 'completed')`,
    ),
  ],
);

/**
 * The orders an account-sync run saw on the vendor's order-history pages. A
 * row is a worklist item, not evidence: `claim_next_import_work` hands the
 * oldest `pending` one to the coordinator, and `ordersSeen` counts these rows
 * rather than commits. No vendorAccount FK: the run already carries it.
 */
export const runOrderCandidate = pgTable(
  "RunOrderCandidate",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
    orderId: text("orderId").notNull(),
    orderUrl: text("orderUrl"),
    orderedAt: date("orderedAt", { mode: "string" }),
    state: text("state").notNull().default("pending"),
    listedAt: timestamp("listedAt", { mode: "date" }).notNull().defaultNow(),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("RunOrderCandidate_run_order_key").on(
      table.runId,
      table.orderId,
    ),
    index("RunOrderCandidate_run_state_idx").on(table.runId, table.state),
    check(
      "RunOrderCandidate_state_check",
      sql`${table.state} IN ('pending', 'covered', 'imported', 'skipped')`,
    ),
  ],
);

/** Immutable R2-backed evidence scoped to a run target, never a shared Image. */
export const runEvidence = pgTable(
  "RunEvidence",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
    targetId: uuid("targetId")
      .notNull()
      .references(() => runTarget.id),
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
    uniqueIndex("RunEvidence_object_key_unique").on(table.objectKey),
    index("RunEvidence_run_target_idx").on(table.runId, table.targetId),
    check(
      "RunEvidence_kind_check",
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
      .references(() => run.id),
    lastRunId: uuid("lastRunId")
      .notNull()
      .references(() => run.id),
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

/** Replay-safe boundary for Flue durable tools and external side effects. */
export const runOperation = pgTable(
  "RunOperation",
  {
    id: pkUuid(),
    executor:
      jsonb("executor").$type<
        import("@cubby/schemas/activity").ActivityExecutor
      >(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
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
    uniqueIndex("RunOperation_run_operation_key").on(
      table.runId,
      table.operationId,
    ),
    index("RunOperation_run_state_idx").on(table.runId, table.state),
    check(
      "RunOperation_state_check",
      sql`${table.state} IN ('started', 'paused_approval', 'completed', 'failed')`,
    ),
  ],
);

/**
 * An agent's proposed grouping of a photo-inventory run's images, awaiting
 * human review. Approval runs the bounded `commit_photo_group` writer with
 * this row's payload; `committed`/`discarded` rows are frozen history.
 * Product and Location are real FKs so a merge can repoint and a delete can
 * detach them; the image roster, category and owner party stay in the
 * payload because images are pinned by `RunTarget` and the writer
 * re-resolves every code at approval time.
 */
export const photoGroupProposal = pgTable(
  "PhotoGroupProposal",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .$type<RunId>()
      .references(() => run.id),
    groupKey: text("groupKey").notNull(),
    state: text("state")
      .notNull()
      .default("proposed")
      .$type<"proposed" | "committed" | "discarded">(),
    images: jsonb("images")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<{ imageId: ImageId; purpose: "item" | "label" }[]>(),
    skip: jsonb("skip")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<{ imageId: ImageId; reason: string }[]>(),
    productKind: text("productKind").notNull().$type<"existing" | "create">(),
    /** The chosen existing Product, or — once committed — the Product the group attached to. */
    productId: uuid("productId")
      .$type<ProductId>()
      .references(() => product.id),
    /**
     * `commit_photo_group`'s `product.create` payload when `productKind` is
     * `create`, minus its category: that lives in `productCreateCategoryId`
     * so a merge or delete between proposing and approving is followed.
     */
    productCreate:
      jsonb("productCreate").$type<
        import("@cubby/schemas/photo-import-run").CommitPhotoGroupProductCreate
      >(),
    productCreateCategoryId: uuid(
      "productCreateCategoryId",
    ).$type<ProductCategoryId>(),
    inventoryLocationId: uuid("inventoryLocationId")
      .$type<LocationId>()
      .references(() => location.id),
    /**
     * `commit_photo_group`'s inventory minus `locationId` and the owner, which
     * lives in `inventoryOwnerPartyId`; null = no inventory.
     */
    inventory:
      jsonb("inventory").$type<
        import("@cubby/schemas/photo-import-run").PhotoGroupStoredInventory
      >(),
    inventoryOwnerPartyId: uuid("inventoryOwnerPartyId")
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    evidence: text("evidence"),
    /** Product shortcodes that collided with a `create` name on the last approval. */
    conflictProductIds: jsonb("conflictProductIds").$type<string[]>(),
    lastError: text("lastError"),
    committedAt: timestamp("committedAt", { mode: "date" }),
    ...baseTimestamps(),
  },
  (table) => [
    // Named explicitly: Drizzle's default exceeds Postgres's 63-byte limit.
    foreignKey({
      name: "PhotoGroupProposal_productCreateCategoryId_fk",
      columns: [table.productCreateCategoryId],
      foreignColumns: [productCategory.id],
    }),
    uniqueIndex("PhotoGroupProposal_run_group_key").on(
      table.runId,
      table.groupKey,
    ),
    index("PhotoGroupProposal_product_idx").on(table.productId),
    index("PhotoGroupProposal_location_idx").on(table.inventoryLocationId),
    check(
      "PhotoGroupProposal_state_check",
      sql`${table.state} IN ('proposed', 'committed', 'discarded')`,
    ),
    check(
      "PhotoGroupProposal_product_kind_check",
      sql`${table.productKind} IN ('existing', 'create')`,
    ),
  ],
);

/** Durable progress events for Flue and other background Runs. */
export const runProgress = pgTable(
  "RunProgress",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
    eventId: text("eventId").notNull(),
    phase: text("phase").notNull(),
    currentItem: text("currentItem"),
    awaitingApproval: boolean("awaitingApproval").notNull().default(false),
    detail: text("detail"),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("RunProgress_eventId_unique").on(table.eventId),
    index("RunProgress_run_created_idx").on(
      table.runId,
      table.createdAt.desc(),
    ),
  ],
);

/** Immutable record of which household member prompted, approved, or stopped a run. */
export const runControlEvent = pgTable(
  "RunControlEvent",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
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
    index("RunControlEvent_run_created_idx").on(table.runId, table.createdAt),
    check(
      "RunControlEvent_action_check",
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
      .references(() => run.id),
    targetPurchaseId: uuid("targetPurchaseId")
      .$type<PurchaseId>()
      .references(() => purchase.id),
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
export const runApproval = pgTable(
  "RunApproval",
  {
    id: pkUuid(),
    runId: uuid("runId")
      .notNull()
      .references(() => run.id),
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
    uniqueIndex("RunApproval_run_operation_key").on(
      table.runId,
      table.operationId,
    ),
    index("RunApproval_run_state_idx").on(table.runId, table.state),
    check(
      "RunApproval_state_check",
      sql`${table.state} IN ('pending', 'granted', 'rejected', 'consumed', 'invalidated')`,
    ),
  ],
);

const runFindingKinds = ["purchase", "expense", "product", "run"] as const;

export const runFinding = pgTable(
  "RunFinding",
  {
    id: pkUuid(),
    runId: uuid("runId").references(() => run.id),
    ledgerPartyId: uuid("ledgerPartyId")
      .notNull()
      .$type<LedgerPartyId>()
      .references(() => ledgerParty.id),
    ...entityRef({ nullable: false, kinds: runFindingKinds }),
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
    uniqueIndex("RunFinding_open_evidence_key")
      .on(
        table.ledgerPartyId,
        table.entityKind,
        table.entityId,
        table.kind,
        table.evidenceFingerprint,
      )
      .where(sql`${table.status} = 'open'`),
    index("RunFinding_status_idx").on(table.status, table.createdAt.desc()),
    check(
      "RunFinding_status_check",
      sql`${table.status} IN ('open', 'applied', 'dismissed')`,
    ),
    check(
      "RunFinding_entityKind_check",
      sql`${table.entityKind} IN ('purchase', 'expense', 'product', 'run')`,
    ),
    // Findings stay live pointers (ADR 0006): a merge repoints them and a
    // removal deletes them, so the FK always names a live identity.
    entityRefFk("RunFinding_entity_fk", table),
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
    receiptRunId: uuid("receiptRunId").references(() => run.id),
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
    classifiedChecksum: text("classifiedChecksum"),
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
    supersededAt: timestamp("supersededAt", { mode: "date" }),
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

/** Human decisions about a specific mail event and proposed Purchase match. */
export const orderMailCandidateDecision = pgTable(
  "OrderMailCandidateDecision",
  {
    id: pkUuid(),
    eventId: uuid("eventId")
      .notNull()
      .references(() => orderMailEvent.id),
    purchaseId: uuid("purchaseId")
      .notNull()
      .$type<PurchaseId>()
      .references(() => purchase.id),
    decision: text("decision").notNull().$type<"linked" | "dismissed">(),
    evidenceChecksum: text("evidenceChecksum").notNull(),
    decidedByUserId: text("decidedByUserId").notNull(),
    ...baseTimestamps(),
  },
  (table) => [
    uniqueIndex("OrderMailCandidateDecision_event_purchase_key").on(
      table.eventId,
      table.purchaseId,
    ),
    uniqueIndex("OrderMailCandidateDecision_one_link_key")
      .on(table.eventId)
      .where(sql`${table.decision} = 'linked'`),
    index("OrderMailCandidateDecision_purchase_idx").on(table.purchaseId),
    check(
      "OrderMailCandidateDecision_decision_check",
      sql`${table.decision} IN ('linked', 'dismissed')`,
    ),
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
    // Object-storage key (`order-mail-attachment/<id>`) of the pending bytes.
    pendingObjectKey: text("pendingObjectKey"),
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
    // rule as `purchaseProduct`'s. One live row per (transaction, purchase): two
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

export const statementImport = pgTable(
  "StatementImport",
  {
    id: pkUuid(),
    source: text("source")
      .notNull()
      .references(() => externalSource.slug, { onUpdate: "cascade" }),
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
 * `settlement_ref` `EntityExternalId` names its `(source, externalId)` pair.
 * That join needs no DISTINCT because the live `(source, kind, externalId)`
 * unique allows one owner per pair.
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
    source: text("source")
      .notNull()
      .references(() => externalSource.slug, { onUpdate: "cascade" }),
    externalId: text("externalId").notNull(),
    rowPosition: integer("rowPosition"),
    providerTransactionId: text("providerTransactionId"),
    legacyExternalId: text("legacyExternalId"),

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
    uniqueIndex("StatementRow_batch_position_key")
      .on(table.batchId, table.rowPosition)
      .where(sql`${table.deletedAt} IS NULL`),
    index("StatementRow_source_providerTransactionId_idx").on(
      table.source,
      table.providerTransactionId,
    ),
    index("StatementRow_batchId_idx").on(table.batchId),
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
      "StatementRow_position_check",
      sql`${table.rowPosition} IS NULL OR ${table.rowPosition} > 0`,
    ),
    check(
      "StatementRow_source_slug_check",
      sql`${table.source} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND ${table.source} = lower(trim(${table.source}))`,
    ),
    check(
      "StatementRow_amount_whole_cent_check",
      sql`abs(${table.amount} * 100 - round(${table.amount} * 100)) < 0.0000001`,
    ),
    check(
      "StatementRow_providerAmount_whole_cent_check",
      sql`abs(${table.providerAmount} * 100 - round(${table.providerAmount} * 100)) < 0.0000001`,
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
      sql`${table.externalId} ~ '^v[12]:[0-9a-f]{64}$'`,
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
    source: text("source")
      .notNull()
      .references(() => externalSource.slug, { onUpdate: "cascade" }),
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

export const entityExternalIdRelations = relations(
  entityExternalId,
  ({ one }) => ({
    // Entity ids are unique across tables, so the product side of a row is
    // exact without a kind filter.
    product: one(product, {
      fields: [entityExternalId.entityId],
      references: [product.id],
      relationName: "productExternalIds",
    }),
    recipe: one(recipe, {
      fields: [entityExternalId.entityId],
      references: [recipe.id],
      relationName: "recipeExternalIds",
    }),
    externalSource: one(externalSource, {
      fields: [entityExternalId.source],
      references: [externalSource.slug],
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

/**
 * One relation per subject kind; ids are unique across entity tables, so a
 * join on `entityId` needs no kind filter.
 */
export const entityAttachmentRelations = relations(
  entityAttachment,
  ({ one }) => ({
    image: one(image, {
      fields: [entityAttachment.imageId],
      references: [image.id],
    }),
    product: one(product, {
      fields: [entityAttachment.entityId],
      references: [product.id],
    }),
    location: one(location, {
      fields: [entityAttachment.entityId],
      references: [location.id],
    }),
    gardenEntry: one(gardenEntry, {
      fields: [entityAttachment.entityId],
      references: [gardenEntry.id],
    }),
    recipe: one(recipe, {
      fields: [entityAttachment.entityId],
      references: [recipe.id],
    }),
    meal: one(meal, {
      fields: [entityAttachment.entityId],
      references: [meal.id],
    }),
    task: one(task, {
      fields: [entityAttachment.entityId],
      references: [task.id],
    }),
    purchase: one(purchase, {
      fields: [entityAttachment.entityId],
      references: [purchase.id],
    }),
    project: one(project, {
      fields: [entityAttachment.entityId],
      references: [project.id],
    }),
    cookbook: one(cookbook, {
      fields: [entityAttachment.entityId],
      references: [cookbook.id],
    }),
    vendor: one(vendor, {
      fields: [entityAttachment.entityId],
      references: [vendor.id],
    }),
  }),
);

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

export const aiAnalysis = pgTable(
  "AiAnalysis",
  {
    id: pkUuid(),
    entityKind: text("entityKind").notNull().$type<AiAnalysisEntityKind>(),
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
        table.entityKind,
        table.entityId,
        table.feature,
        table.model,
        table.promptVersion,
        table.inputFingerprint,
        sql`coalesce(${table.provider}, '')`,
        sql`coalesce(${table.resultSchemaRevision}, 0)`,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("AiAnalysis_entity_idx").on(table.entityKind, table.entityId),
    index("AiAnalysis_feature_idx").on(table.feature),
    check(
      "AiAnalysis_entityKind_check",
      sql`${table.entityKind} IN ('image', 'location', 'product', 'recipe', 'global')`,
    ),
    // 'global' analyses (no owning entity) always have a null entityId, and
    // every other kind always names one; MATCH SIMPLE lets the null id skip
    // the FK check below for the global case.
    check(
      "AiAnalysis_global_check",
      sql`(${table.entityKind} = 'global') = (${table.entityId} IS NULL)`,
    ),
    // A rebuildable pointer to a live identity (ADR 0006); null on 'global'.
    foreignKey({
      name: "AiAnalysis_entity_fk",
      columns: [table.entityId, table.entityKind],
      foreignColumns: [entityIdentity.id, entityIdentity.kind],
    }),
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
    // Every AI call belongs to a Run, which carries the caller attribution.
    runId: uuid("runId")
      .notNull()
      .$type<RunId>()
      .references(() => run.id),
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
    applicationCacheStatus: text("applicationCacheStatus").$type<
      "hit" | "miss" | "none"
    >(),
    ...entityRef<string>({ nullable: true }),
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
    index("AiUsage_entity_idx").on(table.entityKind, table.entityId),
    index("AiUsage_job_idx").on(table.jobKind, table.jobId),
    index("AiUsage_run_idx").on(table.runId),
    // Both columns are nullable (a call may have no subject entity); MATCH
    // SIMPLE skips the FK check whenever either is null (ADR 0006).
    entityRefFk("AiUsage_entity_fk", table),
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
    entityKind: text("entityKind").$type<Entity>(),
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
      table.entityKind,
      table.occurredAt.desc(),
    ),
  ],
);

export const auditLog = pgTable(
  "AuditLog",
  {
    id: pkUuid(),
    ...entityRef<AuditEntityKind>({ nullable: false }),
    action: text("action").notNull(), // 'create', 'update', 'delete'
    // Flat field diffs. An Image row written for an ImageSighting nests them
    // (`AuditStoredChanges`); every reader goes through `readStoredChanges`.
    changes: jsonb("changes").$type<Record<string, AuditFieldChange>>(),
    userId: text("userId")
      .notNull()
      .$type<UserId>()
      .references(() => user.id),
    channel: text("channel").notNull().$type<AuditChannel>().default("web"),
    // Deliberately not an FK: revoking an OAuth client deletes it, while the
    // audit trail must keep the caller identity.
    oauthClientId: text("oauthClientId"),
    deviceId: uuid("deviceId")
      .$type<DeviceId>()
      .references(() => device.id, { onDelete: "set null" }),
    runId: uuid("runId")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // NULLS FIRST is Postgres's own `DESC` default: it matches the feed's
    // `ORDER BY "createdAt" DESC, id DESC` and the index production carries.
    // Drizzle's bare `.desc()` would declare NULLS LAST, which that ORDER BY
    // cannot scan.
    index("AuditLog_createdAt_id_idx").on(
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Real identity FK (ADR 0006): the row names an entity that exists, of
    // the kind it claims. History keeps the identity that received the event.
    entityRefFk("AuditLog_entity_fk", table),
    // Everything one Run wrote, narrowed by entity kind (import provenance).
    index("AuditLog_runId_entityKind_idx")
      .on(table.runId, table.entityKind)
      .where(sql`${table.runId} IS NOT NULL`),
    check(
      "AuditLog_channel_check",
      sql`${table.channel} IN ('web', 'api', 'mcp', 'caldav', 'system')`,
    ),
    index("AuditLog_entityKind_entityId_createdAt_idx").on(
      table.entityKind,
      table.entityId,
      table.createdAt.desc(),
    ),
  ],
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  identity: one(entityIdentity, {
    fields: [auditLog.entityId],
    references: [entityIdentity.id],
  }),
  user: one(user, {
    fields: [auditLog.userId],
    references: [user.id],
  }),
  device: one(device, {
    fields: [auditLog.deviceId],
    references: [device.id],
  }),
  run: one(run, {
    fields: [auditLog.runId],
    references: [run.id],
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
