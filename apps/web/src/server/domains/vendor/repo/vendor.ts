import type { ActorContext } from "@cubby/schemas/context";
import { type VendorUpdateData } from "@cubby/schemas/entities/vendor";
/** Vendor spend is derived only from `SUM(Expense.cost)` through live purchases. */
import { entityRefKey } from "@cubby/schemas/entity";
import {
  vendorRawOut as rawVendorOut,
  type VendorRawOut as RawVendorOut,
} from "@cubby/schemas/entity-contracts/vendor";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type PurchaseId,
  type ImageId,
  parseEntityId,
  parseShortcodeFor,
  type VendorId,
  type VendorShortcode,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import {
  scopedPositionState,
  currentScopedPosition,
  type MailSearchState,
} from "@cubby/schemas/mailbox-research";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import type {
  VendorMergeSummaryOut,
  VendorOptionsOut,
} from "@cubby/schemas/vendor";
import { vendorAgentHints } from "@cubby/schemas/vendor-import-fields";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  getDb,
  lockAndValidateForDelete,
  databaseForTransaction,
  isTransaction,
  notDeleted,
  shortcodeSetCondition,
  sqlEnumConstant,
  withTransaction,
} from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  expense,
  image,
  product,
  productCategory,
  purchase,
  vendor,
} from "~/server/db/schema";
import { reapUnreferencedImages } from "~/server/domains/image/repo/image";
import { displayableImageSql } from "~/server/domains/image/repo/image-displayability";
import {
  detachVendorIdentifierSources,
  repointVendorIdentifierSources,
} from "~/server/domains/product/repo/product-identifier-source";
import { readCompletedControlledSearches } from "~/server/domains/purchase-import/repo/controlled-mail-import";
import { loadGmailCursor } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { listMemberMailboxes } from "~/server/domains/purchase-import/repo/gmail/targets";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";
import { vendorMailQueries } from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";
import { foldChargeInto } from "~/server/domains/purchase/repo/purchase";
import {
  effectivePurchaseItemizationExpectationSql,
  purchaseHasItemizationSql,
  purchaseHasPrimaryDocumentSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { vendorEvidenceFieldResolutionsSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";
import {
  assertShipmentCarrierDeletionAllowed,
  repointShipmentCarrierReferences,
} from "~/server/domains/shipment/repo/carrier-references";
import { assertReviewedSpendingClassification } from "~/server/domains/spending-category/repo/spending-classification-review-authorization";
import { foldVendorAccountsInto } from "~/server/domains/vendor-account/repo/vendor-account";
import { vendorStatementLabels } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { vendorSearch } from "~/server/domains/vendor/repo/search-read-vendor";
import { agentHintsLabel } from "~/server/entity-kernel/repo/detail-display-labels";
import {
  resolveEntityAttachments,
  resolveEntityDisplayImages,
} from "~/server/entity-kernel/repo/entity-display-image";
import { patchEntityRows } from "~/server/entity-kernel/repo/entity-patch";
import {
  type MutationReceipt,
  createEntityReader,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  replaceSingularAttachment,
  singularAttachmentImageIds,
} from "~/server/entity-kernel/repo/singular-attachment";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { createAppError } from "~/server/errors/app-error";
import { ENTITY_STORED_WRITES } from "~/server/generated/entity-write-bindings.gen";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { loadVendorPurchaseEvidence } from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import { validateProductPolicy } from "~/server/generic/inheritance/repo/inheritance-validation";
import { listPrepare } from "~/server/generic/list/repo/field-compiler";
import { declaredRollup } from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import { planSlotCollisions } from "~/server/generic/merge/repo/collisions";
import {
  finalizeMerge,
  mergeNotes,
  repointEdge,
  resolveMergeTargets,
} from "~/server/generic/merge/repo/core";
import {
  applyMergePolicy,
  policyDelete,
} from "~/server/generic/removal/repo/dispositions";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  findOrCreateWithShortcode,
  insertWithShortcode,
} from "~/server/generic/shortcode/repo/shortcode-utils";

import { loadVendorCategoryEvidence } from "./vendor-suggestion-context";

export const VENDOR_DELETE_EDGE_POLICY = {
  "Shipment.carrierId": {
    code: "block-carried-shipments",
    effect: "block",
    description:
      "Shipments retain their carrier identity until explicitly reassigned.",
  },
  "PhotoGroupProposal.productCreateBrandId": {
    code: "block-photo-brand-proposals",
    effect: "block",
    description: "Pending photo proposals retain their selected Brand.",
  },
  "Product.brandId": {
    code: "block-branded-products",
    effect: "block",
    description: "Products retain their Brand until explicitly reassigned.",
  },
  "SourceOrderObservation.vendorId": {
    code: "preserve-source-observation",
    effect: "preserve",
    description:
      "Immutable extraction history retains its original subject UUID and tombstone without being repointed.",
  },
  "FinancialAccount.providerVendorId": {
    code: "block-financial-accounts",
    effect: "block",
    description: "A financial account retains its provider organization.",
  },
  "Run.vendorId": {
    code: "block-runs",
    effect: "block",
    description: "Import history retains the vendor it processed.",
  },
  "VendorAccount.vendorId": {
    code: "block-vendor-accounts",
    effect: "block",
    description: "Vendor accounts retain their configured vendor.",
  },
  "OrderMail.vendorId": {
    code: "block-order-mail",
    effect: "block",
    description: "Normalized order mail retains its classified vendor.",
  },
  "Purchase.vendorId": {
    code: "block-live-purchase",
    effect: "block",
    description:
      "A vendor with purchases still pointing at it can't be deleted — those purchases are load-bearing history.",
  },
  "EntityAttachment.entityId": {
    code: "cascade-delete-attachment",
    effect: "soft-delete",
    description:
      "The logo association is soft-deleted with the vendor; the image is reaped when nothing else uses it.",
  },
  "ImportPreparedOrder.vendorId": {
    code: "preserve-prepared-vendor",
    effect: "preserve",
    description:
      "An import preparation keeps the Vendor it named; its commit refuses a deleted Vendor.",
  },
  "ExternalSource.vendorId": {
    code: "clear-source-vendor",
    effect: "detach",
    description:
      "Identifier sources that named this vendor stay registered and simply stop naming it; an unowned source issues no Product identifiers.",
  },
} as const satisfies IncomingEdgePolicy<"vendor", OperationDisposition>;

export const VENDOR_MERGE_EDGE_POLICY = {
  "Shipment.carrierId": {
    code: "repoint-shipment-carrier",
    effect: "repoint",
    description: "Shipments name the surviving carrier Vendor.",
  },
  "PhotoGroupProposal.productCreateBrandId": {
    code: "repoint-photo-brand-proposals",
    effect: "repoint",
    description: "Pending photo proposals follow the surviving Brand.",
  },
  "Product.brandId": {
    code: "repoint-product-brands",
    effect: "repoint",
    description: "Products name the surviving Brand identity.",
  },
  "SourceOrderObservation.vendorId": {
    code: "preserve-source-observation",
    effect: "preserve",
    description:
      "Immutable extraction history retains its original subject UUID and tombstone without being repointed.",
  },
  "FinancialAccount.providerVendorId": {
    code: "block-financial-accounts",
    effect: "block",
    description:
      "Financial accounts must be reassigned explicitly before merging their provider vendors.",
  },
  "Run.vendorId": {
    code: "repoint-runs",
    effect: "repoint",
    description: "A merged vendor's import runs name the surviving vendor.",
  },
  "VendorAccount.vendorId": {
    code: "fold-member-accounts",
    effect: "move-dedupe",
    description:
      "A merged vendor's member account moves to the survivor; when the survivor already has one for that member, its purchases, runs and source claims re-point there, the later sync cursor is kept, and the duplicate account is retired.",
  },
  "OrderMail.vendorId": {
    code: "repoint-order-mail",
    effect: "repoint",
    description: "A merged vendor's classified order mail names the survivor.",
  },
  "Purchase.vendorId": {
    code: "repoint-or-fold-by-order",
    effect: "move-dedupe",
    description:
      "A merged vendor's purchases re-point onto the surviving vendor; purchases that collide on the same order id are folded into one instead.",
  },
  "EntityAttachment.entityId": {
    code: "carry-logo",
    effect: "repoint",
    description:
      "A loser's logo becomes the survivor's when the survivor has none; any other loser logo is detached and reaped unless shared.",
  },
  "ImportPreparedOrder.vendorId": {
    code: "preserve-prepared-vendor",
    effect: "preserve",
    description:
      "An import preparation keeps the Vendor it named; its commit refuses a merged-away Vendor, which is prepared again.",
  },
  "ExternalSource.vendorId": {
    code: "repoint-source-vendor",
    effect: "repoint",
    description:
      "Identifier sources that named a merged vendor name the survivor; merging two Vendors that each issue Product identifiers is refused until one issuer is reconciled.",
  },
} as const satisfies IncomingEdgePolicy<"vendor", OperationDisposition>;

/**
 * `purchaseCount` and `spend`, as correlated scalar subqueries rather than a
 * `GROUP BY` join.
 *
 * Two reasons for subqueries over joins: the count query for pagination stays
 * untouched, and summing expenses through a join would multiply the vendor row
 * by its purchases and then by their expenses — the classic fan-out double-count.
 * Nesting keeps each aggregate independent.
 *
 * Both guard `deletedAt` at BOTH levels. A soft-deleted charge's expenses must
 * not reach a vendor's spend, and an emptied charge (expenses deleted, charge
 * kept) must read as zero rather than as its old total.
 *
 * `related()` renders every reference qualified. This file is where Drizzle's
 * bare-column trap showed its loud face: interpolated columns emitted
 * `WHERE "vendorId" = "id"`, which made `/vendors` fail outright with
 * `column reference "id" is ambiguous` and made `vendorOptions` silently
 * count 0.
 */
const vendorPurchases = () =>
  related(purchase, (p) => sql`${p.vendorId} = ${outer(vendor.id)}`);
const vendorBrandedProducts = () =>
  related(product, (g) => sql`${g.brandId} = ${outer(vendor.id)}`);

// Declared rollups (`vendor.model.derived`); the manifest owns their SQL.
const vendorPurchaseCount = declaredRollup("vendor", "purchaseCount", vendor);

const role = rawVendorOut.shape.role.enum;
const vendorRole = sql<RawVendorOut["role"]>`(SELECT CASE
  WHEN roles.seller AND roles.brand THEN ${sqlEnumConstant(rawVendorOut.shape.role, role.both)}
  WHEN roles.seller THEN ${sqlEnumConstant(rawVendorOut.shape.role, role.seller)}
  WHEN roles.brand THEN ${sqlEnumConstant(rawVendorOut.shape.role, role.brand)}
  ELSE ${sqlEnumConstant(rawVendorOut.shape.role, role.unused)} END
  FROM (SELECT ${vendorPurchases().exists()} AS seller,
    ${vendorBrandedProducts().exists()} AS brand) roles)`;

const vendorBrandCategoryCount = vendorBrandedProducts()
  .join(productCategory, (pc, g) => sql`${pc.id} = ${g.categoryId}`)
  .countDistinct((pc) => pc.id);

const vendorPurchasedBrandProductCount = vendorBrandedProducts()
  .where((g) =>
    related(expense, (e) => sql`${e.productId} = ${g.id}`)
      .join(purchase, (p, e) => sql`${p.id} = ${e.purchaseId}`)
      .exists(),
  )
  .count();

// Brand attribution requires a linked live Product. Seller spend also includes
// unlinked lines; these two sums overlap and must never be added together.
const vendorBrandSpend = vendorBrandedProducts()
  .join(expense, (e, g) => sql`${e.productId} = ${g.id}`)
  .where((e) =>
    related(purchase, (p) => sql`${p.id} = ${e.purchaseId}`).exists(),
  )
  .sum((e) => e.cost);

const vendorDocumentedPurchaseCount = sql<number>`(SELECT count(*)::int FROM "Purchase" vp
  WHERE vp."vendorId"=${outer(vendor.id)} AND ${notDeleted("vp")}
    AND ${purchaseHasPrimaryDocumentSql("vp")})`;

const vendorMissingItemizationCount = sql<number>`(SELECT count(*)::int FROM "Purchase" vp
  WHERE vp."vendorId"=${outer(vendor.id)} AND ${notDeleted("vp")}
    AND ${effectivePurchaseItemizationExpectationSql("vp")}=${sqlEnumConstant(itemizationExpectation, itemizationExpectation.enum.required)}
    AND NOT ${purchaseHasItemizationSql("vp")})`;

const vendorLatestPurchaseDate = vendorPurchases().max<string>((p) => p.date);

/**
 * Each live Vendor's Mail search state (`MailSearchState`) across every
 * member's connected Google mailbox, by Vendor id; a Vendor with no searches
 * is absent. Computed here rather than in SQL: the website's search needs the
 * public suffix list (`vendorMailQueries`), and keyed lookups keep it linear in
 * searches plus stored coverage entries.
 */
async function loadVendorMailSearch(
  client: Database | DrizzleTransaction,
  ids?: readonly VendorId[],
  shortcodes?: readonly string[],
): Promise<Record<string, MailSearchState>> {
  const db = isTransaction(client) ? databaseForTransaction(client) : client;
  const [rows, mailboxes] = await Promise.all([
    getDb(db)
      .select({
        id: vendor.id,
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(
        and(
          notDeleted(vendor),
          ids ? inArray(vendor.id, [...ids]) : undefined,
          shortcodes
            ? shortcodeSetCondition(sql`${vendor.shortcode}`, [...shortcodes])
            : undefined,
        ),
      ),
    listMemberMailboxes(db),
  ]);
  const [cursors, controlledSearches] = await Promise.all([
    Promise.all(
      mailboxes.map(async (mailbox) => {
        const { coverage } = await loadGmailCursor(db, mailbox);
        return coverage;
      }),
    ),
    readCompletedControlledSearches(
      db,
      rows.map((row) => row.id),
    ),
  ]);
  return Object.fromEntries(
    rows.flatMap((row) => {
      const queries = vendorMailQueries(row.id, vendorSearchTerms(row));
      if (queries.length === 0) return [];
      const states = cursors.flatMap((cursor, index) =>
        queries.map((query) => {
          const mailbox = mailboxes[index];
          const completed = mailbox
            ? controlledSearches.get(
                `${row.id}/${mailbox.ledgerPartyId}/${mailbox.mailboxId}`,
              )
            : undefined;
          return scopedPositionState(
            currentScopedPosition(cursor, query, completed),
          );
        }),
      );
      const state: MailSearchState =
        states.length > 0 && states.every((value) => value === "done")
          ? "done"
          : states.some((value) => value !== "not_started")
            ? "in_progress"
            : "not_started";
      return [[row.id, state]];
    }),
  );
}

/** The prepared state of the row's Vendor: one keyed lookup per row. */
const vendorMailSearchSql = (states: Record<string, MailSearchState>) =>
  sql<MailSearchState | null>`(${JSON.stringify(states)}::jsonb ->> (${sql.raw('"Vendor"."id"')}::text))`;

// An id-restricted read (a list enrichment page) selects only those rows, so
// it needs only their states; loading every Vendor ran per enrichment page.
const requestedIds = z.object({ ids: z.array(z.string()).optional() });
const vendorMailSearch = listPrepare((db, values) =>
  loadVendorMailSearch(db, undefined, requestedIds.parse(values).ids),
);

export async function getVendorCoverage(
  db: Database,
  input: { vendorId: VendorShortcode; from: string; to: string },
) {
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const vendorRow = await readVendor(db, input.vendorId);
  if (!vendorRow) {
    throw createAppError(
      "VENDOR_NOT_FOUND",
      `Vendor ${input.vendorId} not found`,
    );
  }
  const rows = await getDb(db)
    .selectDistinct({ orderId: purchase.orderId })
    .from(purchase)
    .where(
      and(
        eq(purchase.vendorId, vendorId),
        notDeleted(purchase),
        gte(purchase.date, input.from),
        lte(purchase.date, input.to),
        isNotNull(purchase.orderId),
      ),
    )
    .orderBy(asc(purchase.orderId));
  return {
    vendor: { id: vendorRow.id, name: vendorRow.name },
    latestPurchaseDate: vendorRow.latestPurchaseDate,
    from: input.from,
    to: input.to,
    orderIds: rows.flatMap((row) => (row.orderId == null ? [] : [row.orderId])),
  };
}

const vendorHasDisplayableLogo = sql<boolean>`EXISTS (
  SELECT 1 FROM "EntityAttachment" logo_att
  JOIN "Image" logo ON logo."id" = logo_att."imageId"
  WHERE logo_att."entityId" = ${sql.raw('"Vendor"."id"')}
    AND logo_att."role" = 'logo'
    AND ${notDeleted("logo_att")}
    AND ${notDeleted("logo")}
    AND ${displayableImageSql("logo")}
)`;

/**
 * The Vendor read, stated once: list pages, selected projections and the
 * single-record read all select through it.
 */
export const vendorScaffold = listScaffold("vendor", vendor, {
  derived: {
    role: vendorRole,
    brandCategoryCount: vendorBrandCategoryCount,
    purchasedBrandProductCount: vendorPurchasedBrandProductCount,
    brandSpend: vendorBrandSpend,
    documentedPurchaseCount: vendorDocumentedPurchaseCount,
    missingItemizationCount: vendorMissingItemizationCount,
    // A vendor with no purchases leads a newest-first list.
    latestPurchaseDate: { sql: vendorLatestPurchaseDate, nulls: "high" },
    mailSearch: vendorMailSearch.value(vendorMailSearchSql),
    needsClassification: sql`${vendor.defaultSpendingCategoryId} IS NULL`,
    hasLogo: sql`${vendorHasDisplayableLogo}`,
  },
  read: {
    optionCount: "purchaseCount",
    search: vendorSearch,
    evidence: { purchaseCount: loadVendorPurchaseEvidence },
    columns: { fieldResolutions: vendorEvidenceFieldResolutionsSql("Vendor") },
    references: {
      defaultSpendingCategoryId: {
        kind: "lookup",
        name: "defaultSpendingCategoryName",
        emoji: "defaultSpendingCategoryEmoji",
        missing: "null",
      },
    },
    bindings: (bind) => [
      bind
        .ids(({ db, ids }) =>
          vendorStatementLabels(
            db,
            ids.map((id) => parseEntityId("vendor", id)),
          ),
        )
        .fields(
          rawVendorOut.pick({ statementLabels: true }),
          (row, labels) => ({
            statementLabels: labels.get(row.id) ?? [],
          }),
        ),
      bind(rawVendorOut.pick({ agentHintsLabel: true }), (row) => ({
        agentHintsLabel: agentHintsLabel(
          vendorAgentHints.parse(row.agentHints),
        ),
      })),
      bind
        .ids(({ db, ids }) => resolveEntityAttachments(db, "vendor", ids))
        .fields(rawVendorOut.pick({ logo: true }), (row, attachments) => ({
          logo:
            attachments
              .get(row.id)
              ?.find(
                (attachment) =>
                  attachment.role === "logo" &&
                  isDisplayableImageFile(attachment),
              ) ?? null,
        })),
      bind
        .ids(({ db, ids }) =>
          Promise.all(
            ids.map(
              async (id) =>
                [id, await loadVendorCategoryEvidence(db, id)] as const,
            ),
          ).then((loaded) => new Map(loaded)),
        )
        .fields(
          rawVendorOut.pick({
            purchasedCategories: true,
            principalLineCount: true,
            unknownCategoryLineCount: true,
          }),
          (row, evidence) => {
            const loaded = evidence.get(row.id);
            if (!loaded) throw new Error(`No category evidence: ${row.id}`);
            return loaded;
          },
          { scope: "detail" },
        ),
    ],
  },
});

const vendorReader = createEntityReader({
  entity: "vendor",
  scaffold: vendorScaffold,
  output: rawVendorOut,
});
/** One live Vendor by internal id; throws `VENDOR_NOT_FOUND`. */
export const readVendorById = vendorReader.getByID;
/** One live Vendor by public code, or null. */
export const readVendor = vendorReader.getByShortcode;

export const vendorOptions = async (
  db: Database,
): Promise<VendorOptionsOut> => {
  const rows = await getDb(db)
    .select({
      entityId: vendor.id,
      shortcode: vendor.shortcode,
      name: vendor.name,
      count: vendorPurchaseCount,
    })
    .from(vendor)
    .where(notDeleted(vendor))
    .orderBy(desc(vendorPurchaseCount), asc(vendor.name));

  const images = await resolveEntityDisplayImages(
    db,
    rows.map((row) => ({ entityKind: "vendor", entityId: row.entityId })),
  );
  return rows.map((row) => ({
    id: parseShortcodeFor("vendor", row.shortcode),
    name: row.name,
    count: Number(row.count),
    logo: images.get(entityRefKey("vendor", row.entityId)) ?? null,
  }));
};

/**
 * The Vendor named exactly, by its name or a Vendor alias apart from letter
 * case and surrounding spaces, else a new one (race-safe). Near-duplicates
 * require an explicit merge; a name two Vendors share is refused.
 */
export const findOrCreateVendor = async (
  db: Database | DrizzleTransaction,
  name: string,
): Promise<VendorId> => {
  const trimmed = name.trim();
  const [resolved] = await resolveNames(db, "vendor", [{ name: trimmed }], {
    create: false,
  });
  if (resolved?.row) {
    const matches = [resolved.row, ...resolved.candidates];
    // Prefer a canonical spelling over candidates reached through aliases.
    const exactCase = matches.filter((match) => match.name === trimmed);
    if (exactCase.length === 1) return exactCase[0]!.id;
    if (resolved.candidates.length > 0)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Vendor name "${trimmed}" matches ${matches
          .map(({ shortcode }) => shortcode)
          .join(", ")}; name the intended Vendor by id or merge them.`,
      );
    return resolved.row.id;
  }
  const { row } = await findOrCreateWithShortcode(db, "vendor", {
    where: and(
      sql`lower(btrim(${vendor.name})) = lower(${trimmed})`,
      notDeleted(vendor),
    ),
    values: () => ({
      name: trimmed,
    }),
  });
  return row.id;
};

export const createVendor = vendorReader.createWriter(
  ENTITY_STORED_WRITES.vendor.create,
  (output, entityId) => ({ output, entityId }),
);

export const updateVendor = defineMutationWriter({
  entity: "vendor",
  read: async (
    receipt: MutationReceipt<"vendor">,
    db: Database,
    _shortcode: VendorShortcode,
    _data: VendorUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await readVendorById(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: VendorShortcode,
    data: VendorUpdateData,
    actor: ActorContext,
  ) => {
    const id = await resolveOrThrow(db, "vendor", shortcode);

    const defaultSpendingCategoryId =
      data.defaultSpendingCategoryId === undefined
        ? undefined
        : data.defaultSpendingCategoryId === null
          ? null
          : await resolveOrThrow(
              db,
              "spendingCategory",
              data.defaultSpendingCategoryId,
            );
    let reclassifies = false;
    if (
      data.spendingProfile !== undefined ||
      defaultSpendingCategoryId !== undefined
    ) {
      const [current] = await getDb(db)
        .select({
          profile: vendor.spendingProfile,
          target: vendor.defaultSpendingCategoryId,
        })
        .from(vendor)
        .where(and(eq(vendor.id, id), notDeleted(vendor)))
        .limit(1);
      if (!current) throw new Error("Vendor not found");
      if (
        (data.spendingProfile ?? current.profile) !== current.profile ||
        (defaultSpendingCategoryId === undefined
          ? current.target
          : defaultSpendingCategoryId) !== current.target
      ) {
        const affected = await getDb(db).execute(
          sql`SELECT 1 FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE ${notDeleted("e")} AND ${notDeleted("p")} AND p."vendorId"=${id}::uuid LIMIT 1`,
        );
        if (affected.rows.length) {
          assertReviewedSpendingClassification(db);
          reclassifies = true;
        }
      }
    }
    await withTransaction(db, async (tx) => {
      await patchEntityRows(
        tx,
        actor,
        {
          entity: "vendor",
          table: vendor,
          fields: entityFieldModels.vendor.audit,
        },
        [id],
        { ...data, defaultSpendingCategoryId, name: data.name?.trim() },
      );
      // A new profile or default reclassifies this Vendor's lines, so it can
      // put a linked Product in a category that forbids one.
      if (reclassifies) await validateProductPolicy(tx, { vendorId: id });
    });

    return readOutput({ entityId: id });
  },
});

/** Row locking serializes logo replacement; shared old images are preserved. */
export const replaceVendorLogo = async (
  db: Database,
  input: {
    id: VendorShortcode;
    expectedWebsite: string;
    image: Omit<typeof image.$inferInsert, "id" | "status" | "shortcode">;
  },
  actor: ActorContext,
): Promise<{
  output: RawVendorOut;
  entityId: VendorId;
  detachedImageKeys: string[];
}> => {
  const { entityId, detachedImageKeys } = await withTransaction(
    db,
    async (tx) => {
      const entityId = await resolveOrThrow(tx, "vendor", input.id);
      const [before] = await tx
        .select({ website: vendor.website })
        .from(vendor)
        .where(and(eq(vendor.id, entityId), notDeleted(vendor)))
        .for("update");
      if (!before) {
        throw createAppError(
          "VENDOR_NOT_FOUND",
          `Vendor not found: ${input.id}`,
        );
      }
      if (before.website !== input.expectedWebsite) {
        throw createAppError(
          "VENDOR_STALE",
          "Vendor website changed while its logo was being fetched. Try again.",
        );
      }

      const created = await insertWithShortcode(tx, "image", {
        ...input.image,
        status: "UPLOADED",
      });
      const { previousImageId } = await replaceSingularAttachment(
        tx,
        entityId,
        "logo",
        created.id,
      );
      await logAuditEntry(tx, actor, {
        entityKind: "vendor",
        entityId,
        action: "update",
        changes: {
          logoImageId: { from: previousImageId, to: created.shortcode },
        },
      });

      const detachedImageKeys = previousImageId
        ? (await reapUnreferencedImages(tx, [previousImageId])).deletedKeys
        : [];
      return { entityId, detachedImageKeys };
    },
  );

  return {
    output: await readVendorById(db, entityId),
    entityId,
    detachedImageKeys,
  };
};

type VendorMergePlan = {
  deletedIds: VendorShortcode[];
  repointed: Array<{ id: PurchaseId; vendorId: VendorId }>;
  folded: Array<{
    deadId: PurchaseId;
    survivorId: PurchaseId;
    vendorId: VendorId;
    notes: string | null;
  }>;
  carried: { website?: string; notes?: string; logoImageId?: ImageId };
};

/** Plan same-order folds before repointing through the partial unique index. */
const planVendorMerge = async (
  dbClient: DrizzleClient | DrizzleTransaction,
  keepId: VendorId,
  losers: VendorId[],
): Promise<VendorMergePlan> => {
  // Carry vendor-level identity the keeper is missing. Same rule as
  // `foldChargeInto`: fill missing identity fields; preserve both records' notes.
  // Without this, merging the row that HAS the website into the row with more
  // history silently discards it — which is the common shape, because the
  // better-populated duplicate is rarely the one with more charges. The real
  // first case was `B&H` (website, 1 charge) vs `B&H Photo` (none, 4 charges).
  const [keeperRow] = await dbClient
    .select({ website: vendor.website, notes: vendor.notes })
    .from(vendor)
    .where(eq(vendor.id, keepId))
    .limit(1);
  const loadedLosers = await dbClient
    .select({
      id: vendor.id,
      shortcode: vendor.shortcode,
      website: vendor.website,
      notes: vendor.notes,
    })
    .from(vendor)
    .where(inArray(vendor.id, losers));
  const loserRows = losers.flatMap((id) => {
    const row = loadedLosers.find((candidate) => candidate.id === id);
    return row ? [row] : [];
  });
  const logos = await singularAttachmentImageIds(
    dbClient,
    [keepId, ...losers],
    "logo",
  );
  const deletedIds = loserRows.map((r) =>
    parseShortcodeFor("vendor", r.shortcode),
  );

  const carried: VendorMergePlan["carried"] = {};
  if (keeperRow?.website == null) {
    const found = loserRows.find((r) => r.website != null)?.website;
    if (found != null) carried.website = found;
  }
  const notes = mergeNotes(
    keeperRow?.notes,
    ...loserRows.map((row) => row.notes),
  );
  if (notes !== keeperRow?.notes && notes !== null) carried.notes = notes;
  if (!logos.has(keepId)) {
    const found = loserRows
      .map((row) => logos.get(row.id))
      .find((imageId) => imageId !== undefined);
    if (found !== undefined) carried.logoImageId = found;
  }

  const allPurchases = await dbClient
    .select({
      id: purchase.id,
      vendorId: purchase.vendorId,
      orderId: purchase.orderId,
      notes: purchase.notes,
    })
    .from(purchase)
    .where(
      and(
        inArray(purchase.vendorId, [keepId, ...losers]),
        notDeleted(purchase),
      ),
    );

  const vendorOrder = [keepId, ...losers];
  allPurchases.sort(
    (a, b) =>
      vendorOrder.indexOf(a.vendorId) - vendorOrder.indexOf(b.vendorId) ||
      a.id.localeCompare(b.id),
  );
  const slotted = planSlotCollisions({
    keeperRows: allPurchases.filter((p) => p.vendorId === keepId),
    loserRows: allPurchases.filter((p) => p.vendorId !== keepId),
    slotKey: (p) => p.orderId,
  });

  const folded: VendorMergePlan["folded"] = slotted.absorb.flatMap(
    ({ into, rows }) => {
      const notes = mergeNotes(into.notes, ...rows.map((donor) => donor.notes));
      return rows.map((row) => ({
        deadId: row.id,
        survivorId: into.id,
        vendorId: row.vendorId,
        notes,
      }));
    },
  );
  const repointed = slotted.repoint.map((p) => ({
    id: p.id,
    vendorId: p.vendorId,
  }));

  return { deletedIds, repointed, folded, carried };
};

/**
 * Folds same-order charges before repointing vendors. Null order IDs never
 * collide; the keeper's existing charge wins each non-null order slot.
 */
export const mergeVendors = async (
  db: Database,
  input: { keepId: VendorShortcode; mergeIds: VendorShortcode[] },
  actor: ActorContext,
): Promise<{
  vendor: RawVendorOut;
  detachedImageKeys: string[];
  mergeSummary: VendorMergeSummaryOut;
}> => {
  const { keepId, loserIds: losers } = await resolveMergeTargets(db, {
    entity: "vendor",
    keepId: input.keepId,
    mergeIds: input.mergeIds,
  });
  let planSummary: Omit<VendorMergeSummaryOut, "keepId"> | undefined;

  const detachedImageKeys = await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, vendor, [keepId, ...losers], "Vendor");
    const designated = await tx
      .select({ id: vendor.id })
      .from(vendor)
      .where(
        and(
          inArray(vendor.id, [keepId, ...losers]),
          isNotNull(vendor.systemKey),
        ),
      );
    if (designated.length)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "System Generic / Unbranded Brand cannot be merged.",
      );

    // The fold plan replaces notes; lock their rows before taking that snapshot.
    await tx
      .select({ id: purchase.id })
      .from(purchase)
      .where(
        and(
          inArray(purchase.vendorId, [keepId, ...losers]),
          notDeleted(purchase),
        ),
      )
      .orderBy(purchase.id)
      .for("update");
    const plan = await planVendorMerge(tx, keepId, losers);
    planSummary = {
      deletedIds: plan.deletedIds,
      merged: 0,
      purchasesRepointed: plan.repointed.length,
      purchasesFolded: plan.folded.length,
      vendorAccountsMoved: 0,
      vendorAccountsFolded: 0,
      carriedFields: Object.keys(plan.carried),
    };

    const { logoImageId: carriedLogo, ...carriedColumns } = plan.carried;
    if (Object.keys(carriedColumns).length > 0) {
      await tx.update(vendor).set(carriedColumns).where(eq(vendor.id, keepId));
    }
    // The losers' names stay Vendor aliases so imports keep finding the keeper.
    let aliasChange: { from: string[]; to: string[] } | undefined;
    const named = await tx
      .select({
        id: vendor.id,
        name: vendor.name,
        aliases: vendor.aliases,
        orderEmailSenders: vendor.orderEmailSenders,
        browserDomains: vendor.browserDomains,
      })
      .from(vendor)
      .where(inArray(vendor.id, [keepId, ...losers]));
    const keeperNamed = named.find(({ id }) => id === keepId);
    // Mail discovery and browser imports find the keeper by the losers'
    // senders and domains too.
    const unionChanges: Partial<
      Record<
        "orderEmailSenders" | "browserDomains",
        { from: string[]; to: string[] }
      >
    > = {};
    if (keeperNamed) {
      for (const key of ["orderEmailSenders", "browserDomains"] as const) {
        const union = uniqBy(
          [
            ...keeperNamed[key],
            ...named
              .filter(({ id }) => id !== keepId)
              .flatMap((row) => row[key]),
          ],
          (value) => value.toLowerCase(),
        );
        if (union.length !== keeperNamed[key].length)
          unionChanges[key] = { from: keeperNamed[key], to: union };
      }
      if (unionChanges.orderEmailSenders || unionChanges.browserDomains)
        await tx
          .update(vendor)
          .set({
            orderEmailSenders: unionChanges.orderEmailSenders?.to,
            browserDomains: unionChanges.browserDomains?.to,
          })
          .where(eq(vendor.id, keepId));
    }
    if (keeperNamed) {
      const seen = new Set([keeperNamed.name.toLowerCase()]);
      const aliases = [
        ...keeperNamed.aliases,
        ...named
          .filter(({ id }) => id !== keepId)
          .flatMap((row) => [row.name, ...row.aliases]),
      ].filter((alias) => {
        const key = alias.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (aliases.length !== keeperNamed.aliases.length) {
        await tx.update(vendor).set({ aliases }).where(eq(vendor.id, keepId));
        aliasChange = { from: keeperNamed.aliases, to: aliases };
      }
    }

    const loserLogos: ImageId[] = [];
    let accountFold = { moved: 0, folded: 0 };
    await applyMergePolicy(tx, {
      entity: "vendor",
      policy: VENDOR_MERGE_EDGE_POLICY,
      keepId,
      loserIds: losers,
      liveOnly: true,
      overrides: {
        "Purchase.vendorId": async () => {
          for (const fold of plan.folded)
            await foldChargeInto(tx, fold.deadId, fold.survivorId, actor, {
              notes: fold.notes,
            });
          // Everything still live moves to the keeper. The doomed charges are
          // already soft-deleted, so `liveOnly` keeps this from re-introducing
          // the collision the fold just resolved.
          await repointEdge(tx, "vendor", "Purchase.vendorId", {
            from: losers,
            to: keepId,
            liveOnly: true,
          });
          // The keeper's food context and default now classify these lines.
          await validateProductPolicy(tx, { vendorId: keepId });
        },
        "ExternalSource.vendorId": () =>
          repointVendorIdentifierSources(tx, { keepId, loserIds: losers }),
        "VendorAccount.vendorId": async () => {
          accountFold = await foldVendorAccountsInto(tx, {
            keepVendorId: keepId,
            loserVendorIds: losers,
            actor,
          });
        },
        // Detach every loser logo before tombstoning, then give the survivor
        // the carried one, so a logo that was not carried is eligible for the
        // same shared-reference reap as an ordinary vendor delete.
        "EntityAttachment.entityId": async () => {
          for (const loserId of losers) {
            const { previousImageId } = await replaceSingularAttachment(
              tx,
              loserId,
              "logo",
              null,
            );
            if (previousImageId) loserLogos.push(previousImageId);
          }
          if (carriedLogo)
            await replaceSingularAttachment(tx, keepId, "logo", carriedLogo);
        },
      },
    });

    await repointShipmentCarrierReferences(tx, keepId, losers, actor);

    type VendorMergeSurvivorChanges = {
      mergedFrom: { from: null; to: VendorId[] };
      carriedOver?: { from: null; to: VendorMergePlan["carried"] };
      foldedCharges?: { from: null; to: PurchaseId[] };
      aliases?: { from: string[]; to: string[] };
      orderEmailSenders?: { from: string[]; to: string[] };
      browserDomains?: { from: string[]; to: string[] };
    };
    const survivorChanges: VendorMergeSurvivorChanges = {
      mergedFrom: { from: null, to: losers },
    };
    if (aliasChange) survivorChanges.aliases = aliasChange;
    Object.assign(survivorChanges, unionChanges);
    planSummary.vendorAccountsMoved = accountFold.moved;
    planSummary.vendorAccountsFolded = accountFold.folded;
    if (Object.keys(plan.carried).length > 0) {
      survivorChanges.carriedOver = { from: null, to: plan.carried };
    }
    if (plan.folded.length > 0) {
      survivorChanges.foldedCharges = {
        from: null,
        to: plan.folded.map((entry) => entry.deadId),
      };
    }

    const { removed } = await finalizeMerge(tx, {
      entity: "vendor",
      table: vendor,
      keepId,
      loserIds: losers,
      removal: "soft",
      actor,
      survivorChanges,
    });
    planSummary.merged = removed;

    return (await reapUnreferencedImages(tx, loserLogos)).deletedKeys;
  });

  const output = await readVendorById(db, keepId);
  return {
    vendor: output,
    detachedImageKeys,
    mergeSummary: { keepId: output.id, ...planSummary! },
  };
};

/**
 * A vendor delete is its declared policy: live purchases, accounts and import
 * provenance block it; its logo attachment goes with it (ADR 0006).
 */
export const deleteVendors = policyDelete("vendor", VENDOR_DELETE_EDGE_POLICY, {
  beforeDelete: assertShipmentCarrierDeletionAllowed,
  overrides: { "ExternalSource.vendorId": detachVendorIdentifierSources },
});
