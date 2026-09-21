import type { ActorContext } from "@cubby/schemas/context";
import {
  type ClearDataExceptionInput,
  type DataCheck,
  type DataException,
  type DataExceptionReason,
  type DataQuality,
  type DataQualityException,
  type DataQualityFacetName,
  type DataQualityGap,
  dataCheckFacet,
  dataCheckWeight,
  isDefectDataCheck,
  type ProductDataCheck,
  type PurchaseDataCheck,
  productDataCheck,
  purchaseDataCheck,
  type SetDataExceptionInput,
} from "@cubby/schemas/data-quality";
import { externalIdKind } from "@cubby/schemas/external-id";
import type {
  ProductId,
  ProductShortcode,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import {
  ENTITY_NOT_FOUND_REASON,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  type ImageRenderStatus,
  type ImageStorageStatus,
  isDisplayableImageFile,
} from "@cubby/schemas/image";
import {
  primaryPurchaseDocumentKinds,
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { parseShortcode, UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { and, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { groupBy, sumBy, uniq, uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  image,
  inventoryEntry,
  product,
  productExternalId,
  productImage,
  purchase,
  purchaseImage,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  calculateFinancialReconciliation,
  postedRefundPredicate,
  postedRefundTotalSql,
  purchaseFinancialMismatchFingerprintRawSql,
  purchaseFinancialMismatchRawSql,
  settlementReferenceAbsentSql,
  settlementReferencePredicate,
} from "~/server/repo/financial-reconciliation";
import {
  displayableImageRawSql,
  displayableImageWhere,
} from "~/server/repo/image-displayability";
import { cents } from "~/server/repo/money";
import {
  emptyPurchaseFinancialAggregate,
  loadPurchaseFinancialAggregates,
  type PurchaseFinancialAggregate,
} from "~/server/repo/purchase-financial-aggregates";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

const AMAZON_SOURCE = "amazon";
const MODEL_REQUIRED_CATEGORIES = [
  "tools",
  "electronics",
  "storage",
  "household",
] as const;
const PURCHASE_FACETS = [
  "identity",
  "paperwork",
  "ledger",
  "settlement",
] as const satisfies readonly DataQualityFacetName[];
const PRODUCT_FACETS = [
  "identity",
  "provenance",
  "integrity",
] as const satisfies readonly DataQualityFacetName[];

const productDetailQualityEvidenceSchema = z.object({
  expenseLinked: z.boolean(),
  amazonLinked: z.boolean(),
  duplicateExternalId: z.boolean(),
});

/** Keep the legacy touch hook for callers that also use it for cache freshness. */
export const touchDataQualityTargets = async (
  tx: DrizzleTransaction,
  targets: {
    productIds?: readonly ProductId[];
    purchaseIds?: readonly PurchaseId[];
  },
  at = new Date(),
): Promise<void> => {
  const productIds = uniq(targets.productIds ?? []);
  const purchaseIds = uniq(targets.purchaseIds ?? []);
  if (productIds.length > 0) {
    await tx
      .update(product)
      .set({ updatedAt: at })
      .where(and(inArray(product.id, productIds), notDeleted(product)));
  }
  if (purchaseIds.length > 0) {
    await tx
      .update(purchase)
      .set({ updatedAt: at })
      .where(and(inArray(purchase.id, purchaseIds), notDeleted(purchase)));
  }
};

const EXCEPTION_REASONS = {
  order_id: ["not_issued", "unavailable"],
  stated_total: ["not_issued", "unavailable"],
  primary_document: ["not_issued", "unavailable", "history_expired"],
  empty_expenses: ["unavailable", "history_expired"],
  settlement_reference: ["not_applicable", "insufficient_detail"],
  // Settlement evidence and the expense ledger can both be correct while a
  // source leaves a small residual. This is never a tolerance: it requires a
  // reasoned, evidence-bound exception and reopens on any evidence change.
  settlement_mismatch: ["expected_mismatch"],
  paperwork_mismatch: ["expected_mismatch"],
  amazon_asin: ["unavailable", "insufficient_detail"],
  // A check absent from this map admits NO reason at all, so its gap can never
  // be closed even when the fact provably does not exist. The three identity
  // checks below sat in that state: a kit component the manufacturer never
  // catalogued separately (for example, an unbranded carrying bag) has no model
  // number to record, and no exception could say so.
  product_manufacturer: ["not_applicable", "unavailable"],
  product_category: ["not_applicable", "insufficient_detail"],
  product_model: ["not_issued", "unavailable"],
  // `unavailable` is the common one and the reason this check earns its keep:
  // a discontinued item whose listings are all retired has NO canonical asset,
  // and substituting a neighbouring generation is worse than no image because
  // the swap is undetectable later. Before this check existed that finding had
  // nowhere to live but free-text notes, so every sweep re-researched the same
  // dead ends. `not_applicable` covers a `misc:` bucket row, which is a
  // stocked pseudo-product that no single photograph describes.
  product_image: ["unavailable", "not_applicable"],
} satisfies Partial<Record<DataCheck, readonly DataExceptionReason[]>>;

const externalIdCollisionKey = (value: {
  source: string;
  kind: string;
  externalId: string;
}) =>
  `${value.source.trim().toLowerCase()}\u0000${value.kind}\u0000${value.externalId}`;

type PurchaseOrderEvidence =
  | "online_account"
  | "receipt_only"
  | "not_expected"
  | null;

/** The two import-driven checks apply only when the vendor can supply them. */
const purchaseExpectedChecks = (
  orderEvidence: PurchaseOrderEvidence,
): readonly PurchaseDataCheck[] => {
  const base = purchaseDataCheck.options.filter(
    (check) => check !== "primary_document" && check !== "empty_expenses",
  );
  if (orderEvidence === "not_expected") return base;
  if (orderEvidence === "receipt_only") return [...base, "primary_document"];
  // Unclassified vendors remain visible until explicitly classified.
  return [...base, "primary_document", "empty_expenses"];
};

const purchaseOrderEvidenceRaw = `(
  SELECT v."orderEvidence" FROM "Vendor" v
  WHERE v."id" = "Purchase"."vendorId" AND v."deletedAt" IS NULL
)`;

const purchaseExpectsDocumentRaw = `(${purchaseOrderEvidenceRaw} IS NULL OR ${purchaseOrderEvidenceRaw} IN ('online_account', 'receipt_only'))`;
const purchaseExpectsExpensesRaw = `(${purchaseOrderEvidenceRaw} IS NULL OR ${purchaseOrderEvidenceRaw} = 'online_account')`;

type FingerprintInput = string | number | boolean | null;

/**
 * One canonical, input-scoped representation shared with the SQL helpers.
 * JSON scalar spelling makes null, strings, numbers, and booleans unambiguous
 * without coupling exception validity to an unrelated row timestamp.
 */
const evidenceFingerprint = (
  check: DataCheck,
  inputs: readonly FingerprintInput[],
): string =>
  `${check}:${inputs.map((input) => JSON.stringify(input)).join("|")}`;

const fingerprintValueSql = (value: SQL): SQL =>
  sql`COALESCE(to_jsonb(${value})::text, 'null')`;

const evidenceFingerprintSql = (
  check: DataCheck,
  inputs: readonly SQL[],
): SQL =>
  sql`${check} || ':' || concat_ws('|', ${sql.join(
    inputs.map(fingerprintValueSql),
    sql`, `,
  )})`;

const fingerprintValueRaw = (value: string): string =>
  `COALESCE(to_jsonb(${value})::text, 'null')`;

const evidenceFingerprintRaw = (
  check: DataCheck,
  inputs: readonly string[],
): string =>
  `'${check}:' || concat_ws('|', ${inputs.map(fingerprintValueRaw).join(", ")})`;

const activeException = (
  column: typeof product.dataExceptions | typeof purchase.dataExceptions,
  check: DataCheck,
  fingerprint: SQL,
): SQL => sql`EXISTS (
  SELECT 1 FROM jsonb_array_elements(${column}) dq_exception
  WHERE dq_exception->>'check' = ${check}
    AND dq_exception->>'fingerprint' = ${fingerprint}
)`;

const productHasExpenses = sql`EXISTS (
  SELECT 1 FROM "Expense" dq_e
  WHERE dq_e."productId" = ${product.id} AND dq_e."deletedAt" IS NULL
)`;

// includes-installed: a fixture is in-scope for quality checks (price,
// model, image) the same as any other stocked product.
const productHasInventory = sql`EXISTS (
  SELECT 1 FROM "InventoryEntry" dq_inventory
  WHERE dq_inventory."productId" = ${product.id}
    AND dq_inventory."deletedAt" IS NULL
)`;

const productHasQualityScope = sql`(${productHasExpenses} OR ${productHasInventory})`;

// Must agree with `productIdsWithImages` (product/crud.ts), findProductsWithNoImages
// (product/analytics.ts) and the problems detector: ProductImage is soft-deletable
// separately from Image, and a PDF manual is not a photo. Joining ProductImage
// alone reads `true` for a product whose only attachment is a manual.
const productHasDisplayableImage = sql`EXISTS (
  SELECT 1 FROM "ProductImage" dq_pimg
  JOIN "Image" dq_img ON dq_img."id" = dq_pimg."imageId" AND dq_img."deletedAt" IS NULL
  WHERE dq_pimg."productId" = ${product.id}
    AND dq_pimg."deletedAt" IS NULL
    AND ${sql.raw(displayableImageRawSql("dq_img"))}
)`;

const productHasAmazonPurchase = sql`EXISTS (
  SELECT 1
  FROM "Expense" dq_ae
  JOIN "Purchase" dq_ap ON dq_ap."id" = dq_ae."purchaseId" AND dq_ap."deletedAt" IS NULL
  JOIN "Vendor" dq_av ON dq_av."id" = dq_ap."vendorId" AND dq_av."deletedAt" IS NULL
  WHERE dq_ae."productId" = ${product.id}
    AND dq_ae."deletedAt" IS NULL
    AND lower(dq_av."name") LIKE 'amazon%'
)`;

const productHasAmazonId = sql`EXISTS (
  SELECT 1 FROM "ProductExternalId" dq_asin
  WHERE dq_asin."productId" = ${product.id}
    AND dq_asin."deletedAt" IS NULL
    AND dq_asin."source" = ${AMAZON_SOURCE}
    AND dq_asin."kind" = 'asin'
)`;

const productHasExternalIdCollision = sql`EXISTS (
  SELECT 1
  FROM "ProductExternalId" dq_mine
  JOIN "ProductExternalId" dq_other
    ON dq_other."source" = dq_mine."source"
   AND dq_other."kind" = dq_mine."kind"
   AND dq_other."externalId" = dq_mine."externalId"
   AND dq_other."productId" <> dq_mine."productId"
   AND dq_other."deletedAt" IS NULL
  JOIN "Product" dq_other_product
    ON dq_other_product."id" = dq_other."productId"
   AND dq_other_product."deletedAt" IS NULL
  WHERE dq_mine."productId" = ${product.id}
    AND dq_mine."deletedAt" IS NULL
)`;

const productFingerprintSql = (check: ProductDataCheck): SQL => {
  switch (check) {
    case "product_manufacturer":
      return evidenceFingerprintSql(check, [sql`${product.manufacturer}`]);
    case "product_category":
      return evidenceFingerprintSql(check, [sql`${product.category}`]);
    case "product_model":
      return evidenceFingerprintSql(check, [
        sql`${product.category}`,
        sql`${product.model}`,
      ]);
    case "product_image":
      return evidenceFingerprintSql(check, [
        productHasInventory,
        productHasDisplayableImage,
      ]);
    case "amazon_asin":
      return evidenceFingerprintSql(check, [
        productHasAmazonPurchase,
        productHasAmazonId,
      ]);
    case "duplicate_external_id":
      return evidenceFingerprintSql(check, [productHasExternalIdCollision]);
  }
};

/**
 * ⚠️ Exhaustive `switch`, deliberately — this used to be a ternary chain whose
 * final `else` was the `duplicate_external_id` predicate. A newly added check
 * therefore fell through to it and compiled clean while producing entirely the
 * wrong SQL. Keep the `never` guard so the compiler catches the next one.
 */
export const productDataGapCondition = (check: ProductDataCheck): SQL => {
  // Scope is per-check, not global. Everything except the image check is in
  // scope once a product has spend OR stock; `product_image` is deliberately
  // narrower — see `productImageScope`.
  let scope = productHasQualityScope;
  let missing: SQL;
  switch (check) {
    case "product_manufacturer":
      missing = sql`(trim(${product.manufacturer}) = '' OR lower(trim(${product.manufacturer})) = lower(${UNSPECIFIED_MANUFACTURER}))`;
      break;
    case "product_category":
      missing = sql`${product.category} IS NULL`;
      break;
    case "product_model":
      missing = sql`${product.category} IN (${sql.join(
        MODEL_REQUIRED_CATEGORIES.map((category) => sql`${category}`),
        sql`, `,
      )}) AND (${product.model} IS NULL OR trim(${product.model}) = '')`;
      break;
    case "product_image":
      // STOCKED ONLY. An image earns its keep for something you can walk up to
      // and fail to recognise on a shelf; for a sold-off or purely historical
      // product it is decoration. Scoping to inventory also keeps this check
      // from lighting up a large share of the catalogue on day one, which is
      // what would have made it noise rather than a worklist.
      scope = productHasInventory;
      missing = sql`NOT ${productHasDisplayableImage}`;
      break;
    case "amazon_asin":
      missing = sql`${productHasAmazonPurchase} AND NOT ${productHasAmazonId}`;
      break;
    case "duplicate_external_id":
      missing = productHasExternalIdCollision;
      break;
    default: {
      const unhandled: never = check;
      throw new Error(`Unhandled product data check: ${String(unhandled)}`);
    }
  }
  // ⚠️ Outer parens LOAD-BEARING. This is a bare conjunction, and callers embed
  // it under `NOT` (`productNeedsDataCondition`) and inside larger boolean
  // trees. Unparenthesized, `NOT <this>` binds only to `scope` — the rest of the
  // conjunction stays positive — so `NOT gap` rendered as
  // `NOT scope AND missing AND …`. AND-ed against the missing group (which
  // requires that same scope) that is a contradiction, and `dataStatus`
  // `needs_data` matched ZERO products unconditionally. Same class as the
  // `not()` note in `presenceCondition` and TAGS_ARE_EMPTY.
  return sql`(${scope} AND ${missing} AND NOT ${activeException(product.dataExceptions, check, productFingerprintSql(check))})`;
};

const productMissingDataCondition = (): SQL =>
  sql`(${sql.join(
    productDataCheck.options
      .filter((check) => !isDefectDataCheck(check))
      .map((check) => productDataGapCondition(check)),
    sql` OR `,
  )})`;

export const productDefectCondition = (): SQL =>
  productDataGapCondition("duplicate_external_id");

export const productNeedsDataCondition = (): SQL =>
  sql`(${productMissingDataCondition()} AND NOT ${productDefectCondition()})`;

// Parenthesized because `productList` filters "complete" as `NOT <this>`. A bare
// `a OR b` there renders `NOT a OR b`, which reads every defective product as
// complete.
export const productAnyDataGapCondition = (): SQL =>
  sql`(${productMissingDataCondition()} OR ${productDefectCondition()})`;

const productFingerprintRaw = (
  check: ProductDataCheck,
  alias: string,
): string => {
  const hasInventory = `EXISTS (SELECT 1 FROM "InventoryEntry" dq_inventory
    WHERE dq_inventory."productId" = ${alias}."id" AND dq_inventory."deletedAt" IS NULL)`;
  const hasDisplayableImage = `EXISTS (SELECT 1 FROM "ProductImage" dq_pimg
    JOIN "Image" dq_img ON dq_img."id" = dq_pimg."imageId" AND dq_img."deletedAt" IS NULL
    WHERE dq_pimg."productId" = ${alias}."id" AND dq_pimg."deletedAt" IS NULL
      AND ${displayableImageRawSql("dq_img")})`;
  const hasAmazonPurchase = `EXISTS (SELECT 1 FROM "Expense" dq_ae
    JOIN "Purchase" dq_ap ON dq_ap."id" = dq_ae."purchaseId" AND dq_ap."deletedAt" IS NULL
    JOIN "Vendor" dq_av ON dq_av."id" = dq_ap."vendorId" AND dq_av."deletedAt" IS NULL
    WHERE dq_ae."productId" = ${alias}."id" AND dq_ae."deletedAt" IS NULL
      AND lower(dq_av."name") LIKE 'amazon%')`;
  const hasAmazonId = `EXISTS (SELECT 1 FROM "ProductExternalId" dq_asin
    WHERE dq_asin."productId" = ${alias}."id" AND dq_asin."deletedAt" IS NULL
      AND dq_asin."source" = '${AMAZON_SOURCE}' AND dq_asin."kind" = 'asin')`;
  const hasCollision = `EXISTS (SELECT 1 FROM "ProductExternalId" dq_mine
    JOIN "ProductExternalId" dq_other ON dq_other."source" = dq_mine."source"
      AND dq_other."kind" = dq_mine."kind" AND dq_other."externalId" = dq_mine."externalId"
      AND dq_other."productId" <> dq_mine."productId" AND dq_other."deletedAt" IS NULL
    JOIN "Product" dq_other_product ON dq_other_product."id" = dq_other."productId"
      AND dq_other_product."deletedAt" IS NULL
    WHERE dq_mine."productId" = ${alias}."id" AND dq_mine."deletedAt" IS NULL)`;
  switch (check) {
    case "product_manufacturer":
      return evidenceFingerprintRaw(check, [`${alias}."manufacturer"`]);
    case "product_category":
      return evidenceFingerprintRaw(check, [`${alias}."category"`]);
    case "product_model":
      return evidenceFingerprintRaw(check, [
        `${alias}."category"`,
        `${alias}."model"`,
      ]);
    case "product_image":
      return evidenceFingerprintRaw(check, [hasInventory, hasDisplayableImage]);
    case "amazon_asin":
      return evidenceFingerprintRaw(check, [hasAmazonPurchase, hasAmazonId]);
    case "duplicate_external_id":
      return evidenceFingerprintRaw(check, [hasCollision]);
  }
};

const activeExceptionRaw = (
  alias: string,
  check: DataCheck,
  fingerprint: string,
) =>
  `EXISTS (
    SELECT 1 FROM jsonb_array_elements(${alias}."dataExceptions") dq_exception
    WHERE dq_exception->>'check' = '${check}'
      AND dq_exception->>'fingerprint' = ${fingerprint}
  )`;

const jsonExceptionAbsentRaw = (
  alias: string,
  check: DataCheck,
  fingerprint: string,
) => `NOT ${activeExceptionRaw(alias, check, fingerprint)}`;

const purchaseProductGapRaw = (check: ProductDataCheck): string => {
  const exceptionAbsent = jsonExceptionAbsentRaw(
    "dq_pr",
    check,
    productFingerprintRaw(check, "dq_pr"),
  );
  const base = `
    EXISTS (
      SELECT 1 FROM "Expense" dq_pe
      JOIN "Product" dq_pr ON dq_pr."id" = dq_pe."productId" AND dq_pr."deletedAt" IS NULL
      WHERE dq_pe."purchaseId" = "Purchase"."id"
        AND dq_pe."deletedAt" IS NULL
        AND dq_pe."productId" IS NOT NULL`;
  // ⚠️ Exhaustive `switch`, deliberately — this was a ternary chain whose final
  // `else` was the `duplicate_external_id` predicate, so a newly added check
  // compiled clean and silently rolled up as a duplicate-ID defect. Keep the
  // `never` guard so the compiler catches the next one.
  let condition: string;
  switch (check) {
    case "product_manufacturer":
      condition = `AND (trim(dq_pr."manufacturer") = '' OR lower(trim(dq_pr."manufacturer")) = lower('${UNSPECIFIED_MANUFACTURER}'))`;
      break;
    case "product_category":
      condition = `AND dq_pr."category" IS NULL`;
      break;
    case "product_model":
      condition = `AND dq_pr."category" IN (${MODEL_REQUIRED_CATEGORIES.map((category) => `'${category}'`).join(", ")})
               AND (dq_pr."model" IS NULL OR trim(dq_pr."model") = '')`;
      break;
    case "product_image":
      // Stocked only, mirroring `productDataGapCondition`. A purchase rolls
      // this up only for a linked product that is still on a shelf.
      condition = `AND EXISTS (
                 SELECT 1 FROM "InventoryEntry" dq_pinv
                 WHERE dq_pinv."productId" = dq_pr."id" AND dq_pinv."deletedAt" IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "ProductImage" dq_pimg
                 JOIN "Image" dq_img ON dq_img."id" = dq_pimg."imageId" AND dq_img."deletedAt" IS NULL
                 WHERE dq_pimg."productId" = dq_pr."id" AND dq_pimg."deletedAt" IS NULL
                   AND ${displayableImageRawSql("dq_img")}
               )`;
      break;
    case "amazon_asin":
      condition = `AND EXISTS (
                 SELECT 1 FROM "Expense" dq_ae
                 JOIN "Purchase" dq_ap ON dq_ap."id" = dq_ae."purchaseId" AND dq_ap."deletedAt" IS NULL
                 JOIN "Vendor" dq_av ON dq_av."id" = dq_ap."vendorId" AND dq_av."deletedAt" IS NULL
                 WHERE dq_ae."productId" = dq_pr."id" AND dq_ae."deletedAt" IS NULL
                   AND lower(dq_av."name") LIKE 'amazon%'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM "ProductExternalId" dq_asin
                 WHERE dq_asin."productId" = dq_pr."id" AND dq_asin."deletedAt" IS NULL
                   AND dq_asin."source" = 'amazon'
                   AND dq_asin."kind" = 'asin'
               )`;
      break;
    case "duplicate_external_id":
      condition = `AND EXISTS (
                 SELECT 1 FROM "ProductExternalId" dq_mine
                 JOIN "ProductExternalId" dq_other
                   ON dq_other."source" = dq_mine."source"
                  AND dq_other."kind" = dq_mine."kind"
                  AND dq_other."externalId" = dq_mine."externalId"
                  AND dq_other."productId" <> dq_mine."productId"
                  AND dq_other."deletedAt" IS NULL
                 JOIN "Product" dq_other_product
                   ON dq_other_product."id" = dq_other."productId"
                  AND dq_other_product."deletedAt" IS NULL
                 WHERE dq_mine."productId" = dq_pr."id" AND dq_mine."deletedAt" IS NULL
               )`;
      break;
    default: {
      const unhandled: never = check;
      throw new Error(`Unhandled product data check: ${String(unhandled)}`);
    }
  }
  // Outer parens for the same reason as `productDataGapCondition`: every gap
  // builder in this module emits ONE group, so a caller can embed it under
  // `NOT` or beside an `OR` without reading its body. A bare `EXISTS (…)` is
  // already safe under `NOT`, but "safe if you inspect it" is the property
  // that failed here — the rule is uniform, and asserted in the unit test.
  return `(${base} ${condition} AND ${exceptionAbsent}))`;
};

const purchaseExpenseCountRaw = (
  alias: string,
) => `(SELECT count(*)::int FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${alias}."id" AND dq_e."deletedAt" IS NULL)`;
const purchaseUnpricedExpenseCountRaw = (
  alias: string,
) => `(SELECT count(*)::int FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${alias}."id" AND dq_e."deletedAt" IS NULL AND dq_e."cost" IS NULL)`;
const purchaseExpenseCentsRaw = (
  alias: string,
) => `floor((COALESCE((SELECT sum(dq_e."cost") FROM "Expense" dq_e
  WHERE dq_e."purchaseId" = ${alias}."id" AND dq_e."deletedAt" IS NULL), 0) * 100)::numeric + 0.5)`;
const moneyCentsRaw = (value: string) =>
  `CASE WHEN ${value} IS NULL THEN NULL ELSE floor((${value} * 100)::numeric + 0.5) END`;
const primaryDocumentExistsRaw = (
  alias: string,
) => `EXISTS (SELECT 1 FROM "PurchaseImage" dq_pi
  JOIN "Image" dq_i ON dq_i."id" = dq_pi."imageId" AND dq_i."deletedAt" IS NULL
  WHERE dq_pi."purchaseId" = ${alias}."id" AND dq_pi."deletedAt" IS NULL
    AND dq_pi."documentKind" IN (${primaryPurchaseDocumentKinds.map((kind) => `'${kind}'`).join(", ")}))`;

const purchaseFingerprintRaw = (check: PurchaseDataCheck): string => {
  const alias = '"Purchase"';
  const expectedDocument = purchaseExpectsDocumentRaw;
  const expectedExpenses = purchaseExpectsExpensesRaw;
  const expenseCount = purchaseExpenseCountRaw(alias);
  const unpricedCount = purchaseUnpricedExpenseCountRaw(alias);
  const expenseCents = purchaseExpenseCentsRaw(alias);
  const statedCents = moneyCentsRaw(`${alias}."statedTotal"`);
  const refundCents = moneyCentsRaw(postedRefundTotalSql(alias));
  switch (check) {
    case "purchase_date":
      return evidenceFingerprintRaw(check, [`${alias}."date"`]);
    case "order_id":
      return evidenceFingerprintRaw(check, [`${alias}."orderId"`]);
    case "stated_total":
      return evidenceFingerprintRaw(check, [statedCents]);
    case "primary_document":
      return evidenceFingerprintRaw(check, [
        expectedDocument,
        primaryDocumentExistsRaw(alias),
      ]);
    case "empty_expenses":
      return evidenceFingerprintRaw(check, [expectedExpenses, expenseCount]);
    case "unpriced_expense":
      return evidenceFingerprintRaw(check, [unpricedCount]);
    case "paperwork_mismatch":
      return evidenceFingerprintRaw(check, [
        statedCents,
        expenseCents,
        expenseCount,
        unpricedCount,
        refundCents,
      ]);
    case "settlement_reference":
      return evidenceFingerprintRaw(check, [
        `NOT (${settlementReferenceAbsentSql(alias)})`,
      ]);
    case "settlement_mismatch":
      return purchaseFinancialMismatchFingerprintRawSql(alias);
  }
};

const purchaseGapRaw = (check: PurchaseDataCheck): string => {
  const exceptionAbsent = jsonExceptionAbsentRaw(
    '"Purchase"',
    check,
    purchaseFingerprintRaw(check),
  );
  if (check === "purchase_date") {
    return `("Purchase"."date" IS NULL AND ${exceptionAbsent})`;
  }
  if (check === "order_id") {
    return `("Purchase"."orderId" IS NULL AND ${exceptionAbsent})`;
  }
  if (check === "stated_total") {
    return `("Purchase"."statedTotal" IS NULL AND ${exceptionAbsent})`;
  }
  if (check === "primary_document") {
    const kinds = primaryPurchaseDocumentKinds
      .map((kind) => `'${kind}'`)
      .join(", ");
    return `(${purchaseExpectsDocumentRaw} AND NOT EXISTS (
      SELECT 1 FROM "PurchaseImage" dq_pi
      JOIN "Image" dq_i ON dq_i."id" = dq_pi."imageId" AND dq_i."deletedAt" IS NULL
      WHERE dq_pi."purchaseId" = "Purchase"."id" AND dq_pi."deletedAt" IS NULL
        AND dq_pi."documentKind" IN (${kinds})
    ) AND ${exceptionAbsent})`;
  }
  if (check === "empty_expenses") {
    return `(${purchaseExpectsExpensesRaw} AND NOT EXISTS (
      SELECT 1 FROM "Expense" dq_e
      WHERE dq_e."purchaseId" = "Purchase"."id" AND dq_e."deletedAt" IS NULL
    ) AND ${exceptionAbsent})`;
  }
  if (check === "unpriced_expense") {
    return `(EXISTS (
      SELECT 1 FROM "Expense" dq_e
      WHERE dq_e."purchaseId" = "Purchase"."id" AND dq_e."deletedAt" IS NULL
        AND dq_e."cost" IS NULL
    ) AND ${exceptionAbsent})`;
  }
  if (check === "paperwork_mismatch") {
    const tolerance = Math.round(RECONCILIATION_TOLERANCE * 100);
    const expenseCents = `floor((COALESCE((SELECT sum(dq_e."cost") FROM "Expense" dq_e
      WHERE dq_e."purchaseId" = "Purchase"."id" AND dq_e."deletedAt" IS NULL), 0) * 100)::numeric + 0.5)`;
    const statedCents = `floor(("Purchase"."statedTotal" * 100)::numeric + 0.5)`;
    const deltaCents = `(${expenseCents} - ${statedCents})`;
    const refundCents = `floor((${postedRefundTotalSql('"Purchase"')} * 100)::numeric + 0.5)`;
    const fullyPriced = `NOT EXISTS (SELECT 1 FROM "Expense" dq_unpriced
      WHERE dq_unpriced."purchaseId" = "Purchase"."id"
        AND dq_unpriced."cost" IS NULL AND dq_unpriced."deletedAt" IS NULL)`;
    const refundAdjusted = `(${fullyPriced} AND ${deltaCents} < ${-tolerance}
      AND ${refundCents} = ${deltaCents})`;
    // Mirrors the zero-expense guard in `reconcilePurchase`: a purchase with no
    // lines is `empty_expenses`, not a mismatch. Without this the `dataGap=`
    // filter disagreed with the hydrated object it filters.
    const hasExpenses = `EXISTS (SELECT 1 FROM "Expense" dq_any
      WHERE dq_any."purchaseId" = "Purchase"."id" AND dq_any."deletedAt" IS NULL)`;
    return `("Purchase"."statedTotal" IS NOT NULL
      AND ${hasExpenses}
      AND abs(${deltaCents}) > ${tolerance}
      AND NOT ${refundAdjusted}
      AND ${exceptionAbsent})`;
  }
  if (check === "settlement_mismatch") {
    return `(${purchaseFinancialMismatchRawSql('"Purchase"')} AND ${exceptionAbsent})`;
  }
  return `(${settlementReferenceAbsentSql('"Purchase"')} AND ${exceptionAbsent})`;
};

export const purchaseDataGapCondition = (check: DataCheck): SQL => {
  const purchaseCheck = purchaseDataCheck.safeParse(check);
  return sql.raw(
    purchaseCheck.success
      ? purchaseGapRaw(purchaseCheck.data)
      : purchaseProductGapRaw(productDataCheck.parse(check)),
  );
};

const purchaseMissingDataCondition = (): SQL =>
  sql.raw(
    `(${purchaseDataCheck.options
      .filter((check) => !isDefectDataCheck(check))
      .map((check) => purchaseGapRaw(check))
      .join(" OR ")})`,
  );

export const purchaseDefectCondition = (): SQL =>
  sql`(${sql.join(
    purchaseDataCheck.options
      .filter(isDefectDataCheck)
      .map((check) => sql.raw(purchaseGapRaw(check))),
    sql` OR `,
  )})`;

export const purchaseNeedsDataCondition = (): SQL =>
  sql`(${purchaseMissingDataCondition()} AND NOT ${purchaseDefectCondition()})`;

// Parenthesized for the same reason as `productAnyDataGapCondition`: `purchaseList`
// filters "complete" as `NOT <this>`.
export const purchaseAnyDataGapCondition = (): SQL =>
  sql`(${purchaseMissingDataCondition()} OR ${purchaseDefectCondition()})`;

type FingerprintedGap = DataQualityGap & { fingerprint: string };

type PurchaseQualityExpense = {
  cost: number | null;
  future: boolean;
};

type PurchaseQualityPurchase = {
  date: string | null;
  orderId: string | null;
  statedTotal: number | null;
  orderEvidence: PurchaseOrderEvidence;
};

const moneyCents = (value: number | null): number | null =>
  value === null ? null : cents(value);

const purchaseFingerprint = (
  check: PurchaseDataCheck,
  row: PurchaseQualityPurchase,
  expenses: readonly PurchaseQualityExpense[],
  documents: readonly { documentKind: string }[],
  postedRefundTotal: number,
  settlementCovered: boolean,
  financial: PurchaseFinancialAggregate,
): string => {
  const expectedChecks = purchaseExpectedChecks(row.orderEvidence);
  const expenseCount = expenses.length;
  const unpricedCount = expenses.filter((item) => item.cost === null).length;
  const expenseCents = cents(sumBy(expenses, (item) => item.cost ?? 0));
  const hasPrimaryDocument = documents.some((document) =>
    primaryPurchaseDocumentKinds.some((kind) => kind === document.documentKind),
  );
  const settleableExpenses = expenses.filter((item) => !item.future);
  const settleableTotal = cents(
    sumBy(settleableExpenses, (item) => item.cost ?? 0),
  );
  const settleableUnpriced = settleableExpenses.filter(
    (item) => item.cost === null,
  ).length;
  switch (check) {
    case "purchase_date":
      return evidenceFingerprint(check, [row.date]);
    case "order_id":
      return evidenceFingerprint(check, [row.orderId]);
    case "stated_total":
      return evidenceFingerprint(check, [moneyCents(row.statedTotal)]);
    case "primary_document":
      return evidenceFingerprint(check, [
        expectedChecks.includes("primary_document"),
        hasPrimaryDocument,
      ]);
    case "empty_expenses":
      return evidenceFingerprint(check, [
        expectedChecks.includes("empty_expenses"),
        expenseCount,
      ]);
    case "unpriced_expense":
      return evidenceFingerprint(check, [unpricedCount]);
    case "paperwork_mismatch":
      return evidenceFingerprint(check, [
        moneyCents(row.statedTotal),
        expenseCents,
        expenseCount,
        unpricedCount,
        cents(postedRefundTotal),
      ]);
    case "settlement_reference":
      return evidenceFingerprint(check, [settlementCovered]);
    case "settlement_mismatch": {
      const mismatch =
        calculateFinancialReconciliation({
          ...financial,
          settleableExpenseTotal: settleableTotal / 100,
          settleableUnpricedExpenseCount: settleableUnpriced,
        }).status === "mismatch";
      const comparisonTotal =
        financial.outstandingTransactionCount > 0
          ? financial.projectedTotal
          : financial.postedTotal;
      return evidenceFingerprint(check, [
        mismatch,
        comparisonTotal,
        settleableTotal / 100,
        settleableUnpriced,
      ]);
    }
  }
};

const purchaseBaseQualityGaps = (
  row: PurchaseQualityPurchase,
  expenses: readonly PurchaseQualityExpense[],
  documents: readonly { documentKind: string }[],
  postedRefundTotal: number,
): Array<[PurchaseDataCheck, string]> => {
  const gaps: Array<[PurchaseDataCheck, string]> = [];
  if (row.date === null)
    gaps.push(["purchase_date", "Purchase date is not recorded."]);
  if (row.orderId === null)
    gaps.push(["order_id", "Vendor order or receipt ID is not recorded."]);
  if (row.statedTotal === null)
    gaps.push(["stated_total", "Literal vendor-stated total is not recorded."]);
  if (
    purchaseExpectedChecks(row.orderEvidence).includes("primary_document") &&
    !documents.some((document) =>
      primaryPurchaseDocumentKinds.some(
        (kind) => kind === document.documentKind,
      ),
    )
  ) {
    gaps.push([
      "primary_document",
      "No primary order confirmation, sales order, invoice, or receipt is attached.",
    ]);
  }
  if (
    purchaseExpectedChecks(row.orderEvidence).includes("empty_expenses") &&
    expenses.length === 0
  ) {
    gaps.push(["empty_expenses", "Purchase has no live Expenses."]);
  }
  const unpriced = expenses.filter((item) => item.cost === null).length;
  if (unpriced > 0) {
    gaps.push([
      "unpriced_expense",
      `${unpriced} linked Expense${unpriced === 1 ? " is" : "s are"} unpriced.`,
    ]);
  }
  if (
    reconcilePurchase({
      statedTotal: row.statedTotal,
      expenseTotal: sumBy(expenses, (item) => item.cost ?? 0),
      expenseCount: expenses.length,
      unpricedExpenseCount: unpriced,
      postedRefundTotal,
    }) === "mismatch"
  ) {
    gaps.push([
      "paperwork_mismatch",
      "Expense total differs from the literal vendor-stated total, and posted refunds do not fully explain it.",
    ]);
  }
  return gaps;
};

/**
 * Settlement evidence is separate from a Purchase's own paperwork. Keep these
 * two checks together so the active-exception gate and the hydrated detail
 * projection use the same raw financial verdict.
 */
const settlementQualityGaps = (
  purchaseId: PurchaseId,
  expenses: readonly PurchaseQualityExpense[],
  settlementCovered: ReadonlySet<PurchaseId>,
  financial: PurchaseFinancialAggregate,
): Array<[PurchaseDataCheck, string]> => {
  const gaps: Array<[PurchaseDataCheck, string]> = [];
  if (!settlementCovered.has(purchaseId)) {
    gaps.push([
      "settlement_reference",
      "No posted qualifying FinancialTransaction with external or cash-account evidence is linked.",
    ]);
  }
  const settleableExpenses = expenses.filter((item) => !item.future);
  const settlement = calculateFinancialReconciliation({
    ...financial,
    settleableExpenseTotal: sumBy(settleableExpenses, (item) => item.cost ?? 0),
    settleableUnpricedExpenseCount: settleableExpenses.filter(
      (item) => item.cost === null,
    ).length,
  });
  if (settlement.status === "mismatch") {
    gaps.push([
      "settlement_mismatch",
      "Settlement evidence differs from incurred Expenses. Review the ledger and source evidence, or record a reasoned expected mismatch.",
    ]);
  }
  return gaps;
};

const qualityStatus = (gaps: DataQualityGap[]): DataQuality["status"] =>
  gaps.some((gap) => gap.kind === "defect")
    ? "defect"
    : gaps.length > 0
      ? "needs_data"
      : "complete";

/**
 * A target's score is independent of related entities: a Purchase can be
 * complete on its own evidence while a linked Product remains incomplete.
 * Active exceptions are absent from `unresolvedGaps`, and therefore count as
 * satisfied. No applicable checks is deliberately a perfect score.
 */
export const calculateDataQualityScore = (
  expectedChecks: readonly DataCheck[],
  unresolvedGaps: readonly DataQualityGap[],
): number => {
  const expected = new Set(expectedChecks);
  const totalWeight = [...expected].reduce(
    (total, check) => total + dataCheckWeight[check],
    0,
  );
  if (totalWeight === 0) return 100;
  const unresolvedWeight = unresolvedGaps.reduce(
    (total, gap) =>
      expected.has(gap.check) ? total + dataCheckWeight[gap.check] : total,
    0,
  );
  const score =
    Math.round(((totalWeight - unresolvedWeight) / totalWeight) * 10_000) / 100;
  return Math.max(0, score);
};

const evaluateTargetQuality = (
  rawGaps: FingerprintedGap[],
  storedExceptions: DataException[],
  targetType: "purchase" | "product",
  targetId: string,
  facetOrder: readonly DataQualityFacetName[],
  expectedChecks: readonly DataCheck[],
): Omit<DataQuality, "relatedGaps" | "relatedExceptions"> => {
  const rawByCheck = new Map(rawGaps.map((gap) => [gap.check, gap]));
  const exceptions: DataQualityException[] = storedExceptions.map(
    ({ fingerprint, ...exception }) => ({
      ...exception,
      targetType,
      targetId,
      state:
        fingerprint !== undefined &&
        rawByCheck.get(exception.check)?.fingerprint === fingerprint
          ? "active"
          : "stale",
    }),
  );
  const activeChecks = new Set(
    exceptions
      .filter((exception) => exception.state === "active")
      .map((exception) => exception.check),
  );
  const gaps = rawGaps
    .filter((gap) => !activeChecks.has(gap.check))
    .map(({ fingerprint: _fingerprint, ...gap }) => gap);
  const facets = facetOrder.map((name) => {
    const facetGaps = gaps.filter((gap) => gap.facet === name);
    return { name, status: qualityStatus(facetGaps), gaps: facetGaps };
  });
  return {
    status: qualityStatus(gaps),
    score: calculateDataQualityScore(expectedChecks, gaps),
    facets,
    gaps,
    exceptions,
  };
};

const uniqueTargetExceptions = (
  exceptions: DataQualityException[],
): DataQualityException[] =>
  uniqBy(
    exceptions,
    (exception) =>
      `${exception.targetType}\u0000${exception.targetId}\u0000${exception.check}`,
  );

type ProductQualityRow = Pick<
  typeof product.$inferSelect,
  "id" | "shortcode" | "manufacturer" | "category" | "model" | "dataExceptions"
>;

type ProductQualityEvidence = {
  expenseLinked: boolean;
  inventoryLinked: boolean;
  imageLinked: boolean;
  amazonLinked: boolean;
  externalIds: Array<{ source: string; kind: string; externalId: string }>;
  duplicateExternalId: boolean;
};

const productFingerprint = (
  check: ProductDataCheck,
  row: ProductQualityRow,
  evidence: ProductQualityEvidence,
): string => {
  const hasAmazonAsin = evidence.externalIds.some(
    (externalId) =>
      externalId.source.toLowerCase() === AMAZON_SOURCE &&
      externalId.kind === "asin",
  );
  switch (check) {
    case "product_manufacturer":
      return evidenceFingerprint(check, [row.manufacturer]);
    case "product_category":
      return evidenceFingerprint(check, [row.category]);
    case "product_model":
      return evidenceFingerprint(check, [row.category, row.model]);
    case "product_image":
      return evidenceFingerprint(check, [
        evidence.inventoryLinked,
        evidence.imageLinked,
      ]);
    case "amazon_asin":
      return evidenceFingerprint(check, [evidence.amazonLinked, hasAmazonAsin]);
    case "duplicate_external_id":
      return evidenceFingerprint(check, [evidence.duplicateExternalId]);
  }
};

const buildProductDataQuality = (
  row: ProductQualityRow,
  evidence: ProductQualityEvidence,
): DataQuality => {
  const gaps: FingerprintedGap[] = [];
  const expectedChecks: ProductDataCheck[] = [];
  const targetId = parseShortcodeFor("product", row.shortcode);
  const add = (check: ProductDataCheck, message: string) => {
    gaps.push({
      check,
      facet: dataCheckFacet[check],
      kind: isDefectDataCheck(check) ? "defect" : "missing",
      targetType: "product",
      targetId,
      message,
      fingerprint: productFingerprint(check, row, evidence),
    });
  };
  if (evidence.expenseLinked || evidence.inventoryLinked) {
    expectedChecks.push("product_manufacturer", "product_category");
    if (
      row.manufacturer.trim() === "" ||
      row.manufacturer.trim().toLowerCase() ===
        UNSPECIFIED_MANUFACTURER.toLowerCase()
    ) {
      add("product_manufacturer", "Manufacturer is not recorded.");
    }
    if (row.category === null) {
      add("product_category", "Product category is not recorded.");
    }
    const modelRequired =
      row.category !== null &&
      MODEL_REQUIRED_CATEGORIES.some((category) => category === row.category);
    if (modelRequired) {
      expectedChecks.push("product_model");
    }
    if (modelRequired && (row.model === null || row.model.trim() === "")) {
      add("product_model", "Manufacturer model is not recorded.");
    }
    if (evidence.inventoryLinked) {
      expectedChecks.push("product_image");
      if (!evidence.imageLinked) {
        add("product_image", "No product image is attached.");
      }
    }
    if (evidence.amazonLinked) {
      expectedChecks.push("amazon_asin");
      if (
        !evidence.externalIds.some(
          (externalId) =>
            externalId.source.toLowerCase() === AMAZON_SOURCE &&
            externalId.kind === "asin",
        )
      ) {
        add("amazon_asin", "Amazon-linked product has no Amazon ASIN.");
      }
    }
    expectedChecks.push("duplicate_external_id");
    if (evidence.duplicateExternalId) {
      add(
        "duplicate_external_id",
        "An exact external identifier is shared with another live product.",
      );
    }
  }
  return {
    ...evaluateTargetQuality(
      gaps,
      row.dataExceptions,
      "product",
      targetId,
      PRODUCT_FACETS,
      expectedChecks,
    ),
    relatedGaps: [],
    relatedExceptions: [],
  };
};

/**
 * Detail-only quality projection: reuse facts already present on the deep base
 * row and fetch the remaining expense/Amazon/collision evidence together.
 */
export const loadProductDetailDataQuality = async (
  db: Database,
  row: ProductQualityRow & {
    inventoryEntry: Array<{ deletedAt: Date | null }>;
    externalIds: Array<{
      source: string;
      kind?: string;
      externalId: string;
      deletedAt: Date | null;
    }>;
    images: Array<{
      deletedAt?: Date | null;
      image: {
        deletedAt: Date | null;
        contentType: string;
        renderStatus?: ImageRenderStatus | null;
        storageStatus?: ImageStorageStatus | null;
      };
    }>;
  },
): Promise<DataQuality> => {
  const query = sql`SELECT
    EXISTS (
      SELECT 1 FROM "Expense" e
      WHERE e."productId" = ${row.id} AND e."deletedAt" IS NULL
    ) AS "expenseLinked",
    EXISTS (
      SELECT 1 FROM "Expense" e
      JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
      JOIN "Vendor" v ON v."id" = p."vendorId" AND v."deletedAt" IS NULL
      WHERE e."productId" = ${row.id} AND e."deletedAt" IS NULL
        AND lower(v."name") LIKE 'amazon%'
    ) AS "amazonLinked",
    EXISTS (
      SELECT 1
      FROM "ProductExternalId" own
      JOIN "ProductExternalId" other
        ON other."source" = own."source"
       AND other."kind" = own."kind"
       AND other."externalId" = own."externalId"
       AND other."productId" <> own."productId"
       AND other."deletedAt" IS NULL
      JOIN "Product" other_product
        ON other_product."id" = other."productId"
       AND other_product."deletedAt" IS NULL
      WHERE own."productId" = ${row.id} AND own."deletedAt" IS NULL
    ) AS "duplicateExternalId"`;
  const result = await unwrapDb(db).execute(query);
  const evidence = productDetailQualityEvidenceSchema.parse(result.rows[0]);

  const externalIds = row.externalIds
    .filter((externalId) => externalId.deletedAt === null)
    .map((externalId) => ({
      source: externalId.source,
      kind: externalId.kind ?? "other",
      externalId: externalId.externalId,
    }));
  return buildProductDataQuality(row, {
    ...evidence,
    inventoryLinked: row.inventoryEntry.some(
      (entry) => entry.deletedAt === null,
    ),
    imageLinked: row.images.some(
      (edge) =>
        edge.deletedAt == null &&
        edge.image.deletedAt === null &&
        isDisplayableImageFile(edge.image),
    ),
    externalIds,
  });
};

export const loadProductDataQualities = async (
  db: Database | DrizzleTransaction,
  ids: ProductId[],
): Promise<Map<ProductId, DataQuality>> => {
  const uniqueIds = uniq(ids);
  if (uniqueIds.length === 0) return new Map();
  const [
    products,
    linkedInventory,
    linkedExpenses,
    amazonExpenses,
    productExternalIds,
    productsWithImages,
  ] = await Promise.all([
    unwrapDb(db)
      .select({
        id: product.id,
        shortcode: product.shortcode,
        manufacturer: product.manufacturer,
        category: product.category,
        model: product.model,
        dataExceptions: product.dataExceptions,
      })
      .from(product)
      .where(and(inArray(product.id, uniqueIds), notDeleted(product))),
    // includes-installed: a fixture is still in scope for the same quality
    // checks (price, model, image) as any stocked product.
    unwrapDb(db)
      .selectDistinct({ productId: inventoryEntry.productId })
      .from(inventoryEntry)
      .where(
        and(
          inArray(inventoryEntry.productId, uniqueIds),
          notDeleted(inventoryEntry),
        ),
      ),
    unwrapDb(db)
      .selectDistinct({ productId: expense.productId })
      .from(expense)
      .where(
        and(
          inArray(expense.productId, uniqueIds),
          isNotNull(expense.productId),
          notDeleted(expense),
        ),
      ),
    unwrapDb(db)
      .selectDistinct({ productId: expense.productId })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .innerJoin(
        vendor,
        and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
      )
      .where(
        and(
          inArray(expense.productId, uniqueIds),
          isNotNull(expense.productId),
          notDeleted(expense),
          sql`lower(${vendor.name}) LIKE 'amazon%'`,
        ),
      ),
    unwrapDb(db)
      .select({
        productId: productExternalId.productId,
        source: productExternalId.source,
        kind: productExternalId.kind,
        externalId: productExternalId.externalId,
      })
      .from(productExternalId)
      .innerJoin(
        product,
        and(eq(product.id, productExternalId.productId), notDeleted(product)),
      )
      .where(
        and(
          inArray(productExternalId.productId, uniqueIds),
          notDeleted(productExternalId),
        ),
      ),
    // Image is soft-deletable independently of ProductImage, and a PDF manual
    // is not a photo — so this joins through and applies displayableImageWhere
    // rather than reading presence off ProductImage alone.
    unwrapDb(db)
      .selectDistinct({ productId: productImage.productId })
      .from(productImage)
      .innerJoin(
        image,
        and(eq(image.id, productImage.imageId), notDeleted(image)),
      )
      .where(
        and(
          inArray(productImage.productId, uniqueIds),
          notDeleted(productImage),
          displayableImageWhere,
        ),
      ),
  ]);

  const externalIdPairs = uniqBy(productExternalIds, externalIdCollisionKey);
  const activeExternalIdOwners =
    externalIdPairs.length === 0
      ? []
      : await (async () => {
          // Keep the collision key as data instead of expanding one OR arm per
          // identifier. A product page can legitimately carry many external
          // ids, and the old shape made the prepared statement grow linearly
          // in both SQL text and bind parameters before Postgres ran it.
          const values = sql.join(
            externalIdPairs.map(
              (row) =>
                sql`(${row.source}::text, ${row.kind}::text, ${row.externalId}::text)`,
            ),
            sql`, `,
          );
          const result = await unwrapDb(db).execute<{
            productId: ProductId;
            source: string;
            kind: string;
            externalId: string;
          }>(sql`
            WITH identifiers("source", "kind", "externalId") AS (
              VALUES ${values}
            )
            SELECT pei."productId", pei.source, pei.kind, pei."externalId"
            FROM "ProductExternalId" pei
            INNER JOIN identifiers input
              ON input.source = pei.source
             AND input.kind = pei.kind
             AND input."externalId" = pei."externalId"
            INNER JOIN "Product" p
              ON p.id = pei."productId"
             AND p."deletedAt" IS NULL
            WHERE pei."deletedAt" IS NULL
          `);
          return result.rows;
        })();

  const expenseLinked = new Set(
    linkedExpenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const inventoryLinked = new Set(linkedInventory.map((row) => row.productId));
  const imageLinked = new Set(productsWithImages.map((row) => row.productId));
  const amazonLinked = new Set(
    amazonExpenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const externalIdsByProduct = groupBy(
    productExternalIds,
    (row) => row.productId,
  );
  const externalIdOwners = groupBy(
    activeExternalIdOwners,
    externalIdCollisionKey,
  );
  const result = new Map<ProductId, DataQuality>();

  for (const row of products) {
    const externalIds = externalIdsByProduct[row.id] ?? [];
    result.set(
      row.id,
      buildProductDataQuality(row, {
        expenseLinked: expenseLinked.has(row.id),
        inventoryLinked: inventoryLinked.has(row.id),
        imageLinked: imageLinked.has(row.id),
        amazonLinked: amazonLinked.has(row.id),
        externalIds,
        duplicateExternalId: externalIds.some(
          (externalId) =>
            (externalIdOwners[externalIdCollisionKey(externalId)]?.length ??
              0) > 1,
        ),
      }),
    );
  }
  return result;
};

/**
 * Attach each row's real, computed DataQuality — never a hardcoded-complete
 * placeholder. `loadProductDataQualities` only returns entries for live
 * products, so a row here that's already known-live (the common case: it was
 * just fetched from the DB in this same call) is guaranteed a map hit; the `!`
 * mirrors the same non-null assertion already used at every other
 * `loadProductDataQualities` call site (purchase.ts's `loadPurchaseDataQualities`
 * sibling, product/crud.ts's productReader).
 */
export const enrichProductRowsWithDataQuality = async <
  T extends { id: ProductId },
>(
  db: Database | DrizzleTransaction,
  products: readonly T[],
): Promise<Array<T & { dataQuality: DataQuality }>> => {
  const qualities = await loadProductDataQualities(
    db,
    products.map((product) => product.id),
  );
  return products.map((product) => {
    const dataQuality = qualities.get(product.id);
    if (!dataQuality) {
      throw new Error(`Data quality was not loaded for product ${product.id}`);
    }
    return { ...product, dataQuality };
  });
};

export const loadPurchaseDataQualities = async (
  db: Database,
  ids: PurchaseId[],
): Promise<Map<PurchaseId, DataQuality>> => {
  const uniqueIds = uniq(ids);
  if (uniqueIds.length === 0) return new Map();
  const [
    purchases,
    documents,
    expenses,
    qualifyingTransactions,
    financialAggregates,
  ] = await Promise.all([
    getDb(db)
      .select({
        id: purchase.id,
        shortcode: purchase.shortcode,
        date: purchase.date,
        orderId: purchase.orderId,
        statedTotal: purchase.statedTotal,
        orderEvidence: sql<PurchaseOrderEvidence>`${vendor.orderEvidence}`,
        dataExceptions: purchase.dataExceptions,
      })
      .from(purchase)
      .innerJoin(
        vendor,
        and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
      )
      .where(and(inArray(purchase.id, uniqueIds), notDeleted(purchase))),
    getDb(db)
      .select({
        purchaseId: purchaseImage.purchaseId,
        documentKind: purchaseImage.documentKind,
      })
      .from(purchaseImage)
      .innerJoin(
        image,
        and(eq(image.id, purchaseImage.imageId), notDeleted(image)),
      )
      .where(
        and(
          inArray(purchaseImage.purchaseId, uniqueIds),
          notDeleted(purchaseImage),
        ),
      ),
    getDb(db)
      .select({
        purchaseId: expense.purchaseId,
        cost: expense.cost,
        productId: expense.productId,
        future: expense.future,
      })
      .from(expense)
      .where(and(inArray(expense.purchaseId, uniqueIds), notDeleted(expense))),
    getDb(db)
      .select({
        purchaseId: financialTransactionAllocation.purchaseId,
        hasSettlementReference: sql<boolean>`bool_or(${sql.raw(
          settlementReferencePredicate(
            '"FinancialTransaction"',
            '"FinancialAccount"',
          ),
        )})`,
        // The allocation's share, matching postedRefundTotalSql — its raw-SQL
        // twin powering the dataGap/dataStatus list filters. These two must
        // stay meaning-equivalent or the filter and the row badge disagree
        // about the same purchase.
        postedRefundTotal: sql<number>`COALESCE(sum(${financialTransactionAllocation.amount}) FILTER (
            WHERE ${sql.raw(postedRefundPredicate('"FinancialTransaction"'))}
          ), 0)::double precision`,
      })
      .from(financialTransactionAllocation)
      .innerJoin(
        financialTransaction,
        and(
          eq(
            financialTransaction.id,
            financialTransactionAllocation.transactionId,
          ),
          notDeleted(financialTransaction),
        ),
      )
      // LEFT, not INNER: account liveness is part of the COVERAGE rule (it reads
      // the account's identity), but not of the refund total — a refund happened
      // whether or not its account row was later retired. An inner join here
      // silently applied the coverage rule to the refund sum too.
      .leftJoin(
        financialAccount,
        eq(financialAccount.id, financialTransaction.accountId),
      )
      .where(
        and(
          inArray(financialTransactionAllocation.purchaseId, uniqueIds),
          notDeleted(financialTransactionAllocation),
        ),
      )
      .groupBy(financialTransactionAllocation.purchaseId),
    loadPurchaseFinancialAggregates(db, uniqueIds),
  ]);
  const expensesByPurchase = groupBy(expenses, (row) => row.purchaseId ?? "");
  const documentsByPurchase = groupBy(documents, (row) => row.purchaseId);
  const settlementCovered = new Set(
    qualifyingTransactions.flatMap((row) =>
      row.purchaseId && row.hasSettlementReference ? [row.purchaseId] : [],
    ),
  );
  const postedRefundByPurchase = new Map(
    qualifyingTransactions.flatMap((row) =>
      row.purchaseId
        ? [[row.purchaseId, Number(row.postedRefundTotal)] as const]
        : [],
    ),
  );
  const productIds = uniq(
    expenses.flatMap((row) => (row.productId ? [row.productId] : [])),
  );
  const productQualities = await loadProductDataQualities(db, productIds);

  const qualityForPurchase = (row: (typeof purchases)[number]): DataQuality => {
    const purchaseExpenses = expensesByPurchase[row.id] ?? [];
    const purchaseDocuments = documentsByPurchase[row.id] ?? [];
    const postedRefundTotal = postedRefundByPurchase.get(row.id) ?? 0;
    const financial =
      financialAggregates.get(row.id) ?? emptyPurchaseFinancialAggregate();
    const hasSettlementReference = settlementCovered.has(row.id);
    const gaps: FingerprintedGap[] = [];
    const targetId = parseShortcodeFor("purchase", row.shortcode);
    const add = (check: PurchaseDataCheck, message: string) => {
      gaps.push({
        check,
        facet: dataCheckFacet[check],
        kind: isDefectDataCheck(check) ? "defect" : "missing",
        targetType: "purchase",
        targetId,
        message,
        fingerprint: purchaseFingerprint(
          check,
          row,
          purchaseExpenses,
          purchaseDocuments,
          postedRefundTotal,
          hasSettlementReference,
          financial,
        ),
      });
    };
    for (const [check, message] of purchaseBaseQualityGaps(
      row,
      purchaseExpenses,
      purchaseDocuments,
      postedRefundTotal,
    )) {
      add(check, message);
    }
    for (const [check, message] of settlementQualityGaps(
      row.id,
      purchaseExpenses,
      settlementCovered,
      financial,
    )) {
      add(check, message);
    }
    const seenProducts = new Set<ProductId>();
    const relatedGaps: DataQualityGap[] = [];
    const relatedExceptions: DataQualityException[] = [];
    for (const item of purchaseExpenses) {
      if (!item.productId || seenProducts.has(item.productId)) continue;
      seenProducts.add(item.productId);
      const productQuality = productQualities.get(item.productId);
      relatedGaps.push(...(productQuality?.gaps ?? []));
      relatedExceptions.push(...(productQuality?.exceptions ?? []));
    }
    return {
      ...evaluateTargetQuality(
        gaps,
        row.dataExceptions,
        "purchase",
        targetId,
        PURCHASE_FACETS,
        purchaseExpectedChecks(row.orderEvidence),
      ),
      relatedGaps: uniqBy(
        relatedGaps,
        (gap) => `${gap.targetId}\u0000${gap.check}`,
      ),
      relatedExceptions: uniqueTargetExceptions(relatedExceptions),
    };
  };
  return new Map(
    purchases.map((row) => [row.id, qualityForPurchase(row)] as const),
  );
};

const assertCheckApplies = (
  entity: "purchase" | "product",
  check: DataCheck,
) => {
  const valid =
    entity === "purchase"
      ? purchaseDataCheck.safeParse(check).success
      : productDataCheck.safeParse(check).success;
  if (!valid) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${check} does not apply to ${entity} data quality.`,
    );
  }
};

const mutateException = async (
  db: Database,
  input: SetDataExceptionInput | ClearDataExceptionInput,
  actor: ActorContext,
): Promise<DataQuality> => {
  const parsed = parseShortcode(input.entityId);
  if (parsed?.type !== "purchase" && parsed?.type !== "product") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.entityId} is not a Purchase or Product.`,
    );
  }
  // Captured after the guard above: the narrowing to purchase|product is lost
  // inside the transaction closure below, and that only started mattering once
  // `image` joined ShortcodeType without being auditable — so the un-narrowed
  // type no longer satisfies the audit entity union.
  const entityType: "purchase" | "product" = parsed.type;
  assertCheckApplies(entityType, input.check);
  if ("reason" in input) {
    const reasonAllowed = Object.entries(EXCEPTION_REASONS).some(
      ([check, reasons]) =>
        check === input.check &&
        reasons.some((reason) => reason === input.reason),
    );
    if (!reasonAllowed) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `${input.reason} is not allowed for ${input.check}.`,
      );
    }
  }
  const resolved = await resolveLiveShortcode(db, input.entityId, parsed.type);
  if (!resolved) {
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[parsed.type],
      `${parsed.type} not found: ${input.entityId}`,
    );
  }

  await withTransaction(db, async (tx) => {
    const currentRow =
      parsed.type === "purchase"
        ? ((
            await tx
              .select({
                dataExceptions: purchase.dataExceptions,
                fingerprint: sql<string>`${sql.raw(
                  purchaseFingerprintRaw(purchaseDataCheck.parse(input.check)),
                )}`,
              })
              .from(purchase)
              .where(
                and(
                  eq(purchase.id, parseEntityId("purchase", resolved)),
                  notDeleted(purchase),
                ),
              )
              .limit(1)
          )[0] ?? null)
        : ((
            await tx
              .select({
                dataExceptions: product.dataExceptions,
                fingerprint: productFingerprintSql(
                  productDataCheck.parse(input.check),
                ),
              })
              .from(product)
              .where(
                and(
                  eq(product.id, parseEntityId("product", resolved)),
                  notDeleted(product),
                ),
              )
              .limit(1)
          )[0] ?? null);
    if (!currentRow) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[parsed.type],
        `${parsed.type} not found: ${input.entityId}`,
      );
    }
    const current = currentRow.dataExceptions;
    const currentFingerprint = String(currentRow.fingerprint);
    if ("reason" in input) {
      const currentlyActive = current.some(
        (item) =>
          item.check === input.check && item.fingerprint === currentFingerprint,
      );
      const applies = currentlyActive
        ? true
        : parsed.type === "purchase"
          ? Boolean(
              (
                await tx
                  .select({ value: purchaseDataGapCondition(input.check) })
                  .from(purchase)
                  .where(
                    and(
                      eq(purchase.id, parseEntityId("purchase", resolved)),
                      notDeleted(purchase),
                    ),
                  )
                  .limit(1)
              )[0]?.value,
            )
          : Boolean(
              (
                await tx
                  .select({
                    value: productDataGapCondition(
                      productDataCheck.parse(input.check),
                    ),
                  })
                  .from(product)
                  .where(
                    and(
                      eq(product.id, parseEntityId("product", resolved)),
                      notDeleted(product),
                    ),
                  )
                  .limit(1)
              )[0]?.value,
            );
      if (!applies) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${input.check} is not an active ${parsed.type} data gap.`,
        );
      }
    }
    const now = new Date();
    // Other exceptions retain their own evidence snapshot. Updating this row's
    // exception metadata is not evidence changing for a different check.
    const retained = current.filter((item) => item.check !== input.check);
    const next =
      "reason" in input
        ? [
            ...retained,
            {
              check: input.check,
              reason: input.reason,
              note: input.note.trim(),
              fingerprint: currentFingerprint,
            },
          ]
        : retained;
    if (parsed.type === "purchase") {
      await updateLiveAndReturn(
        tx,
        purchase,
        { dataExceptions: next, updatedAt: now },
        parseEntityId("purchase", resolved),
      );
    } else {
      await updateLiveAndReturn(
        tx,
        product,
        { dataExceptions: next, updatedAt: now },
        parseEntityId("product", resolved),
      );
    }
    const changes = computeChanges(
      { dataExceptions: current },
      { dataExceptions: next },
      ["dataExceptions"],
    );
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType,
        entityId:
          parsed.type === "purchase"
            ? parseEntityId("purchase", resolved)
            : parseEntityId("product", resolved),
        action: "update",
        changes,
      });
    }
  });

  if (parsed.type === "purchase") {
    const id = parseEntityId("purchase", resolved);
    const quality = (await loadPurchaseDataQualities(db, [id])).get(id);
    if (!quality) {
      throw new Error(`Data quality was not loaded for ${input.entityId}`);
    }
    return quality;
  }
  const id = parseEntityId("product", resolved);
  const quality = (await loadProductDataQualities(db, [id])).get(id);
  if (!quality) {
    throw new Error(`Data quality was not loaded for ${input.entityId}`);
  }
  return quality;
};

export const setDataException = (
  db: Database,
  input: SetDataExceptionInput,
  actor: ActorContext,
) => mutateException(db, input, actor);

export const clearDataException = (
  db: Database,
  input: ClearDataExceptionInput,
  actor: ActorContext,
) => mutateException(db, input, actor);

export const findProductExternalIdCollisions = async (
  db: Database,
  input?: {
    source?: string | string[];
    /** Public shortcode of the product the caller intends to write these onto. */
    productId?: ProductShortcode;
    identifiers?: Array<{ source: string; kind: string; externalId: string }>;
  },
) => {
  const selected = input?.source
    ? [input.source].flat().map((source) => source.trim().toLowerCase())
    : undefined;
  const identifiers = input?.identifiers?.map((identifier) => ({
    ...identifier,
    source: identifier.source.trim().toLowerCase(),
  }));
  const rows = await getDb(db)
    .select({
      source: productExternalId.source,
      kind: productExternalId.kind,
      externalId: productExternalId.externalId,
      productId: product.id,
      productShortcode: product.shortcode,
      productName: product.name,
    })
    .from(productExternalId)
    .innerJoin(
      product,
      and(eq(product.id, productExternalId.productId), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(productExternalId),
        selected && selected.length > 0
          ? inArray(productExternalId.source, selected)
          : identifiers && identifiers.length > 0
            ? or(
                ...identifiers.map((identifier) =>
                  and(
                    eq(productExternalId.source, identifier.source),
                    eq(productExternalId.kind, identifier.kind),
                    eq(productExternalId.externalId, identifier.externalId),
                  ),
                ),
              )
            : undefined,
      ),
    );
  const grouped = groupBy(rows, externalIdCollisionKey);
  const items = Object.entries(grouped).flatMap(([, matches]) => {
    const first = matches[0];
    if (!first || matches.length <= 1) return [];
    return [
      {
        source: first.source.trim().toLowerCase(),
        kind: externalIdKind.parse(first.kind),
        externalId: first.externalId,
        products: matches.map((row) => ({
          id: parseShortcodeFor("product", row.productShortcode),
          name: row.productName,
        })),
      },
    ];
  });
  return {
    items,
    results: (identifiers ?? []).map((identifier) => {
      const matches = grouped[externalIdCollisionKey(identifier)] ?? [];
      // Without `productId`, `unique` can only mean "exactly one live owner,
      // whoever that is" — which reads as a clean pass even when the id sits on
      // a DIFFERENT product. With it, say which.
      const sole = matches.length === 1 ? matches[0] : undefined;
      return {
        ...identifier,
        status:
          matches.length === 0
            ? ("missing" as const)
            : sole
              ? input?.productId === undefined
                ? ("unique" as const)
                : sole.productShortcode === input.productId
                  ? ("owned_by_this" as const)
                  : ("owned_by_other" as const)
              : ("collision" as const),
        products: matches.map((row) => ({
          id: parseShortcodeFor("product", row.productShortcode),
          name: row.productName,
        })),
      };
    }),
  };
};
