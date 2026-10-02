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
  ExpenseId,
  RunId,
  LedgerTransferId,
  ProductId,
  UserId,
  VendorId,
} from "@cubby/schemas/identifiers";
import type { LedgerSourceClaimNormalizedEvidence } from "@cubby/schemas/ledger-transfer";
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
  boolean,
  check,
  customType,
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
  gardenEntry,
  image,
  ledgerTransfer,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  run,
  task,
  vendor,
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

export {
  entityIdentity,
  entityIdentityRelations,
} from "./entity-identity-schema";
// Entity tables + relations are generated from their declarations
// (`packages/schemas/src/entity-definitions/*.entity.ts`, `storage`).
export * from "./generated/entity-tables.gen";

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
