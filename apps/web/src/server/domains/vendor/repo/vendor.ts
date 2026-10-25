import type { ActorContext } from "@cubby/schemas/context";
/** Vendor spend is derived only from `SUM(Expense.cost)` through live purchases. */
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type PurchaseId,
  parseEntityId,
  parseShortcodeFor,
  type VendorId,
  type VendorShortcode,
  type SpendingCategoryShortcode,
} from "@cubby/schemas/identifiers";
import { imageSourceEvidence } from "@cubby/schemas/image-capture-fields";
import {
  scopedPositionState,
  type MailSearchState,
} from "@cubby/schemas/mailbox-research";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import { vendorSpendingProfile } from "@cubby/schemas/spending-classification";
import type {
  VendorCreateInput,
  VendorFilters,
  VendorMergeSummaryOut,
  VendorOptionsOut,
  VendorOut,
  VendorUpdateData,
} from "@cubby/schemas/vendor";
import { vendorOut } from "@cubby/schemas/vendor";
import {
  vendorAgentHints,
  vendorOrderEvidence,
} from "@cubby/schemas/vendor-import-fields";
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

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  getDb,
  type ListReadIntent,
  lockAndValidateForDelete,
  databaseForTransaction,
  isTransaction,
  notDeleted,
  sqlEnumConstant,
  withTransaction,
} from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import {
  entityAttachment,
  expense,
  image,
  product,
  productCategory,
  purchase,
  vendor,
} from "~/server/db/schema";
import { reapUnreferencedImages } from "~/server/domains/image/repo/image";
import {
  displayableImageSql,
  displayableImageWhere,
} from "~/server/domains/image/repo/image-displayability";
import {
  detachVendorIdentifierSources,
  repointVendorIdentifierSources,
} from "~/server/domains/product/repo/product-identifier-source";
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
import { agentHintsLabel } from "~/server/entity-kernel/repo/detail-display-labels";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { patchEntityRows } from "~/server/entity-kernel/repo/entity-patch";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import {
  replaceSingularAttachment,
  singularAttachmentImageIds,
} from "~/server/entity-kernel/repo/singular-attachment";
import { resolveNames } from "~/server/entity-kernel/resolve";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/generic/audit-log/repo/audit-log";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { validateProductPolicy } from "~/server/generic/inheritance/repo/inheritance-validation";
import {
  ListContext,
  listPrepare,
} from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listGroupFields,
  wantsListGroup,
} from "~/server/generic/list/repo/list-projection";
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
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
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
  "MerchantVendorRule.vendorId": {
    code: "block-merchant-rules",
    effect: "block",
    description: "Confirmed merchant rules retain their vendor.",
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
  "MerchantVendorRule.vendorId": {
    code: "block-merchant-rules",
    effect: "block",
    description:
      "Confirmed merchant rules must be reconciled before merging vendors.",
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
/** Expenses on the Vendor's live Purchases. */
const vendorExpenses = () =>
  vendorPurchases().join(expense, (e, p) => sql`${e.purchaseId} = ${p.id}`);

export const vendorPurchaseCount = vendorPurchases().count();

const vendorBrandedProductCount = vendorBrandedProducts().count();

const role = vendorOut.shape.role.enum;
const vendorRole = sql<VendorOut["role"]>`(SELECT CASE
  WHEN roles.seller AND roles.brand THEN ${sqlEnumConstant(vendorOut.shape.role, role.both)}
  WHEN roles.seller THEN ${sqlEnumConstant(vendorOut.shape.role, role.seller)}
  WHEN roles.brand THEN ${sqlEnumConstant(vendorOut.shape.role, role.brand)}
  ELSE ${sqlEnumConstant(vendorOut.shape.role, role.unused)} END
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

const vendorExpenseCount = vendorExpenses().count();

const vendorFirstPurchaseDate = vendorPurchases().min<string>((p) => p.date);

const vendorDocumentedPurchaseCount = sql<number>`(SELECT count(*)::int FROM "Purchase" vp
  WHERE vp."vendorId"=${outer(vendor.id)} AND vp."deletedAt" IS NULL
    AND ${purchaseHasPrimaryDocumentSql("vp")})`;

const vendorMissingItemizationCount = sql<number>`(SELECT count(*)::int FROM "Purchase" vp
  WHERE vp."vendorId"=${outer(vendor.id)} AND vp."deletedAt" IS NULL
    AND ${effectivePurchaseItemizationExpectationSql("vp")}=${sqlEnumConstant(itemizationExpectation, itemizationExpectation.enum.required)}
    AND NOT ${purchaseHasItemizationSql("vp")})`;

const vendorSpend = vendorExpenses().sum((e) => e.cost);

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
        and(notDeleted(vendor), ids ? inArray(vendor.id, [...ids]) : undefined),
      ),
    listMemberMailboxes(db),
  ]);
  const cursors = await Promise.all(
    mailboxes.map(async (mailbox) => {
      const { coverage } = await loadGmailCursor(db, mailbox);
      return new Map(coverage?.scoped.map((entry) => [entry.key, entry]));
    }),
  );
  return Object.fromEntries(
    rows.flatMap((row) => {
      const queries = vendorMailQueries(row.id, vendorSearchTerms(row));
      if (queries.length === 0) return [];
      const states = cursors.flatMap((cursor) =>
        queries.map((query) => {
          const position = cursor.get(query.key);
          return scopedPositionState(
            position?.query === query.query ? position : undefined,
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

const vendorMailSearch = listPrepare((db) => loadVendorMailSearch(db));

export async function getVendorCoverage(
  db: Database,
  input: { vendorId: VendorShortcode; from: string; to: string },
) {
  const vendorId = await resolveOrThrow(db, "vendor", input.vendorId);
  const vendorRow = await getVendorByShortcode(db, input.vendorId);
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
    AND logo_att."deletedAt" IS NULL
    AND logo."deletedAt" IS NULL
    AND ${displayableImageSql("logo")}
)`;

/** The vendor's live logo attachment, for a left join ahead of `image`. */
const vendorLogoAttachment = and(
  eq(entityAttachment.entityId, vendor.id),
  eq(entityAttachment.role, "logo"),
  notDeleted(entityAttachment),
);

const vendorColumns = {
  id: vendor.id,
  shortcode: vendor.shortcode,
  name: vendor.name,
  website: vendor.website,
  orderUrlTemplate: vendor.orderUrlTemplate,
  spendingProfile: vendor.spendingProfile,
  defaultSpendingCategoryName: sql<
    string | null
  >`(SELECT sc.name FROM "SpendingCategory" sc WHERE sc.id = ${vendor.defaultSpendingCategoryId} AND sc."deletedAt" IS NULL)`,
  defaultSpendingCategoryEmoji: sql<
    string | null
  >`(SELECT sc.emoji FROM "SpendingCategory" sc WHERE sc.id = ${vendor.defaultSpendingCategoryId} AND sc."deletedAt" IS NULL)`,
  defaultSpendingCategoryId: sql<SpendingCategoryShortcode | null>`(SELECT sc.shortcode FROM "SpendingCategory" sc WHERE sc.id = ${vendor.defaultSpendingCategoryId} AND sc."deletedAt" IS NULL)`,
  itemizationExpectation: vendor.itemizationExpectation,
  fieldResolutions: vendorEvidenceFieldResolutionsSql("Vendor"),
  orderEvidence: vendor.orderEvidence,
  aliases: vendor.aliases,
  orderEmailSenders: vendor.orderEmailSenders,
  browserDomains: vendor.browserDomains,
  returnWindowDays: vendor.returnWindowDays,
  agentHints: vendor.agentHints,
  notes: vendor.notes,
  createdAt: vendor.createdAt,
  updatedAt: vendor.updatedAt,
  role: vendorRole,
  purchaseCount: vendorPurchaseCount,
  brandedProductCount: vendorBrandedProductCount,
  brandCategoryCount: vendorBrandCategoryCount,
  purchasedBrandProductCount: vendorPurchasedBrandProductCount,
  brandSpend: vendorBrandSpend,
  expenseCount: vendorExpenseCount,
  firstPurchaseDate: vendorFirstPurchaseDate,
  documentedPurchaseCount: vendorDocumentedPurchaseCount,
  missingItemizationCount: vendorMissingItemizationCount,
  spend: vendorSpend,
  latestPurchaseDate: vendorLatestPurchaseDate,
  logo: {
    id: image.shortcode,
    key: image.key,
    filename: image.filename,
    size: image.size,
    contentType: image.contentType,
    status: image.status,
    width: image.width,
    height: image.height,
    detectedContentType: image.detectedContentType,
    sha256: image.sha256,
    renderStatus: image.renderStatus,
    storageStatus: image.storageStatus,
    useOriginal: image.useOriginal,
    verifiedAt: image.verifiedAt,
    source: image.source,
    sourcePageUrl: image.sourcePageUrl,
    sourceAssetUrl: image.sourceAssetUrl,
    sourceName: image.sourceName,
    capturedAt: image.capturedAt,
    capturedAtOffsetMinutes: image.capturedAtOffsetMinutes,
    captureLocation: image.captureLocation,
    capturePlaceName: image.capturePlaceName,
    captureDeviceLabel: image.captureDeviceLabel,
    capturedByPartyId: image.capturedByPartyId,
    captureAttribution: image.captureAttribution,
    provenanceEvidence: image.provenanceEvidence,
    sourceEvidence: image.sourceEvidence,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
  },
} as const;

type VendorRow = {
  id: VendorId;
  shortcode: string;
  name: string;
  aliases: string[];
  website: string | null;
  orderUrlTemplate: string | null;
  spendingProfile: string;
  defaultSpendingCategoryId: SpendingCategoryShortcode | null;
  defaultSpendingCategoryName: string | null;
  defaultSpendingCategoryEmoji: string | null;
  itemizationExpectation: VendorOut["itemizationExpectation"];
  fieldResolutions: VendorOut["fieldResolutions"];
  orderEvidence: string | null;
  orderEmailSenders: string[];
  browserDomains: string[];
  returnWindowDays: number | null;
  agentHints: unknown;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: VendorOut["role"];
  purchaseCount: number;
  brandedProductCount: number;
  brandCategoryCount: number;
  purchasedBrandProductCount: number;
  brandSpend: number;
  expenseCount: number;
  firstPurchaseDate: string | null;
  documentedPurchaseCount: number;
  missingItemizationCount: number;
  spend: number;
  latestPurchaseDate: string | null;
  mailSearch: MailSearchState | null;
  logo: {
    id: string;
    key: string;
    filename: string;
    size: number;
    contentType: string;
    status: "PENDING" | "UPLOADED" | "FAILED";
    width: number | null;
    height: number | null;
    detectedContentType: string | null;
    sha256: string | null;
    renderStatus: "unverified" | "verified" | "failed" | null;
    storageStatus:
      | "unverified"
      | "available"
      | "missing"
      | "metadata_mismatch"
      | null;
    useOriginal: boolean;
    verifiedAt: Date | null;
    source: "own" | "catalog" | "unknown" | "screenshot" | null;
    sourcePageUrl: string | null;
    sourceAssetUrl: string | null;
    sourceName: string | null;
    capturedAt: Date | null;
    capturedAtOffsetMinutes: number | null;
    captureLocation: {
      lat: number;
      lng: number;
      altitude?: number;
      horizontalAccuracy?: number;
    } | null;
    capturePlaceName: string | null;
    captureDeviceLabel: string | null;
    capturedByPartyId: string | null;
    captureAttribution: "none" | "derived" | "ambiguous" | "confirmed" | null;
    provenanceEvidence: {
      basis:
        | "manual"
        | "sighting"
        | "import-url"
        | "exif"
        | "analysis"
        | "filename";
      ruleId?: string;
      detail?: string;
    } | null;
    sourceEvidence: unknown;
    createdAt: Date;
    updatedAt: Date;
  } | null;
};

const vendorLogoToAPI = (logo: VendorRow["logo"]) =>
  logo && {
    ...logo,
    source: logo.source ?? "unknown",
    id: parseShortcodeFor("image", logo.id),
    url: getR2PublicUrl(logo.key),
    // Not resolved here: this select has no join to LedgerParty for a
    // shortcode or a name — a vendor logo is never a member's own photo.
    capturedByPartyId: null,
    capturedByName: null,
    captureAttribution: logo.captureAttribution ?? "none",
    sourceEvidence: imageSourceEvidence.nullable().parse(logo.sourceEvidence),
  };

const dbVendorToAPI = (row: VendorRow, dataQuality: DataQuality): VendorOut => {
  const agentHints = vendorAgentHints.parse(row.agentHints);
  return {
    id: parseShortcodeFor("vendor", row.shortcode),
    name: row.name,
    aliases: row.aliases,
    defaultSpendingCategoryName: row.defaultSpendingCategoryName,
    defaultSpendingCategoryEmoji: row.defaultSpendingCategoryEmoji,
    website: row.website,
    orderUrlTemplate: row.orderUrlTemplate,
    spendingProfile: vendorSpendingProfile.parse(row.spendingProfile),
    defaultSpendingCategoryId: row.defaultSpendingCategoryId,
    itemizationExpectation: row.itemizationExpectation,
    fieldResolutions: row.fieldResolutions,
    orderEvidence: vendorOrderEvidence.nullable().parse(row.orderEvidence),
    orderEmailSenders: row.orderEmailSenders,
    browserDomains: row.browserDomains,
    returnWindowDays: row.returnWindowDays,
    agentHints,
    agentHintsLabel: agentHintsLabel(agentHints),
    notes: row.notes,
    role: row.role,
    purchaseCount: Number(row.purchaseCount),
    brandedProductCount: Number(row.brandedProductCount),
    brandCategoryCount: Number(row.brandCategoryCount),
    purchasedBrandProductCount: Number(row.purchasedBrandProductCount),
    brandSpend: Number(row.brandSpend),
    expenseCount: Number(row.expenseCount),
    firstPurchaseDate: row.firstPurchaseDate,
    documentedPurchaseCount: Number(row.documentedPurchaseCount),
    missingItemizationCount: Number(row.missingItemizationCount),
    spend: Number(row.spend),
    latestPurchaseDate: row.latestPurchaseDate,
    mailSearch: row.mailSearch,
    logo: vendorLogoToAPI(row.logo),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const vendorScaffold = listScaffold("vendor", vendor, {
  derived: {
    spend: vendorSpend,
    role: vendorRole,
    purchaseCount: vendorPurchaseCount,
    brandedProductCount: vendorBrandedProductCount,
    brandCategoryCount: vendorBrandCategoryCount,
    purchasedBrandProductCount: vendorPurchasedBrandProductCount,
    brandSpend: vendorBrandSpend,
    expenseCount: vendorExpenseCount,
    firstPurchaseDate: vendorFirstPurchaseDate,
    documentedPurchaseCount: vendorDocumentedPurchaseCount,
    missingItemizationCount: vendorMissingItemizationCount,
    // A vendor with no purchases leads a newest-first list.
    latestPurchaseDate: { sql: vendorLatestPurchaseDate, nulls: "high" },
    mailSearch: vendorMailSearch.value(vendorMailSearchSql),
    needsClassification: sql`${vendor.defaultSpendingCategoryId} IS NULL`,
    hasLogo: sql`${vendorHasDisplayableLogo}`,
  },
});

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildVendorWhereClause = (
  filters: VendorFilters,
  context: ListContext = ListContext.empty,
) => vendorScaffold.where(filters, { context });

export const vendorListRead = async (
  db: Database,
  filters: VendorFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
  projection: ListProjection = { kind: "full" },
) => {
  const {
    role,
    purchaseCount,
    brandedProductCount,
    brandCategoryCount,
    purchasedBrandProductCount,
    brandSpend,
    expenseCount,
    firstPurchaseDate,
    documentedPurchaseCount,
    missingItemizationCount,
    spend,
    latestPurchaseDate,
    fieldResolutions,
    logo,
    ...core
  } = vendorColumns;
  const request = { filters, sorts, pagination, readIntent, projection };
  const context = await vendorScaffold.context(db, request);
  return vendorScaffold.read(db, request, {
    context,
    where: buildVendorWhereClause(filters, context),
    select: async (page) => {
      const query = getDb(db)
        .select({
          ...core,
          ...listGroupFields(projection, "derived", () => ({
            role,
            purchaseCount,
            brandedProductCount,
            brandCategoryCount,
            purchasedBrandProductCount,
            brandSpend,
            expenseCount,
            firstPurchaseDate,
            documentedPurchaseCount,
            missingItemizationCount,
            spend,
            latestPurchaseDate,
            fieldResolutions,
            mailSearch: vendorMailSearchSql(context.get(vendorMailSearch)),
          })),
          ...listGroupFields(projection, "media", () => ({ logo })),
        })
        .from(vendor)
        .where(page.where)
        .orderBy(...page.orderBy)
        .limit(page.limit)
        .offset(page.offset)
        .$dynamic();
      if (wantsListGroup(projection, "media"))
        return query
          .leftJoin(entityAttachment, vendorLogoAttachment)
          .leftJoin(
            image,
            and(
              eq(image.id, entityAttachment.imageId),
              notDeleted(image),
              displayableImageWhere,
            ),
          );
      return query;
    },
    read: {
      references: { defaultSpendingCategoryId: { kind: "public" } },
      bindings: (bind) => [
        bind(vendorOut.pick({ agentHintsLabel: true }), (row) => ({
          agentHintsLabel: agentHintsLabel(
            vendorAgentHints.parse(row.agentHints),
          ),
        })),
        bind(vendorOut.pick({ logo: true }), (row) => ({
          logo: vendorLogoToAPI(row.logo ?? null),
        })),
      ],
    },
  });
};

export const vendorListSummary = async (
  db: Database,
  filters: VendorFilters,
) => {
  const [totals] = await getDb(db)
    .select({
      spend: sql<number>`COALESCE(sum(${vendorSpend}), 0)::double precision`,
      purchaseCount: sql<number>`COALESCE(sum(${vendorPurchaseCount}), 0)::int`,
    })
    .from(vendor)
    .where(
      buildVendorWhereClause(
        filters,
        await vendorScaffold.context(db, { filters, readIntent: "count" }),
      ),
    );
  return {
    spend: Number(totals?.spend ?? 0),
    purchaseCount: Number(totals?.purchaseCount ?? 0),
  };
};

export const vendorList = async (
  db: Database,
  filters: VendorFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
): Promise<{
  data: VendorOut[];
  count: number;
  sums?: { spend: number; purchaseCount: number };
}> => {
  const [page, sums] = await Promise.all([
    vendorListRead(db, filters, sorts, pagination, readIntent),
    readIntent === "page" ? vendorListSummary(db, filters) : undefined,
  ]);
  const result = {
    ...page,
    data: page.data.map((row) => vendorOut.parse(row)),
  };
  if (sums) Object.assign(result, { sums });
  return result;
};

export const getVendorByID = async (
  db: Database,
  id: VendorId,
): Promise<VendorOut> => {
  const [row] = await getDb(db)
    .select({
      ...vendorColumns,
      mailSearch: vendorMailSearchSql(await loadVendorMailSearch(db, [id])),
    })
    .from(vendor)
    .leftJoin(entityAttachment, vendorLogoAttachment)
    .leftJoin(
      image,
      and(
        eq(image.id, entityAttachment.imageId),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .where(and(eq(vendor.id, id), notDeleted(vendor)))
    .limit(1);
  if (!row) {
    throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${id}`);
  }
  const dataQualities = await loadDataQualities(db, "vendor", [row.id]);
  // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
  return {
    ...dbVendorToAPI(row, dataQualities.get(row.id)!),
    ...(await loadVendorCategoryEvidence(db, row.shortcode)),
  };
};

export const getVendorByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<VendorOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "vendor");
  return id ? getVendorByID(db, parseEntityId("vendor", id)) : null;
};

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
    // A legacy pair differing only in case keeps resolving the exact spelling.
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
    where: and(eq(vendor.name, trimmed), notDeleted(vendor)),
    values: () => ({
      name: trimmed,
    }),
  });
  return row.id;
};

export const createVendor = defineMutationWriter({
  entity: "vendor",
  read: async (
    receipt: MutationReceipt<"vendor">,
    db: Database,
    _data: VendorCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await getVendorByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: VendorCreateInput,
    actor: ActorContext,
  ) => {
    const id = await withTransaction(db, async (tx) => {
      const created = await insertWithShortcode(tx, "vendor", {
        name: data.name.trim(),
        website: data.website,
        orderUrlTemplate: data.orderUrlTemplate,
        spendingProfile: data.spendingProfile,
        defaultSpendingCategoryId: data.defaultSpendingCategoryId
          ? await resolveOrThrow(
              tx,
              "spendingCategory",
              data.defaultSpendingCategoryId,
            )
          : null,
        itemizationExpectation: data.itemizationExpectation,
        orderEvidence: data.orderEvidence,
        aliases: data.aliases,
        orderEmailSenders: data.orderEmailSenders,
        browserDomains: data.browserDomains,
        returnWindowDays: data.returnWindowDays,
        agentHints: data.agentHints,
        notes: data.notes,
      });
      await logAuditEntry(tx, actor, {
        entityKind: "vendor",
        entityId: created.id,
        action: "create",
      });
      return created.id;
    });
    return readOutput({ entityId: id });
  },
});

export const updateVendor = defineMutationWriter({
  entity: "vendor",
  read: async (
    receipt: MutationReceipt<"vendor">,
    db: Database,
    _shortcode: VendorShortcode,
    _data: VendorUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await getVendorByID(db, receipt.entityId),
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
          sql`SELECT 1 FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p."vendorId"=${id}::uuid LIMIT 1`,
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
  output: VendorOut;
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
    output: await getVendorByID(db, entityId),
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
  carried: { website?: string; notes?: string; logoImageId?: string };
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
  vendor: VendorOut;
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

    const loserLogos: string[] = [];
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

  const output = await getVendorByID(db, keepId);
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
