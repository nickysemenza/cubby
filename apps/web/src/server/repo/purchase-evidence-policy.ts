import { primaryPurchaseDocumentKinds } from "@cubby/schemas/purchase";
import type {
  FinancialTransactionCoverage,
  PurchaseEvidenceCoverage,
} from "@cubby/schemas/purchase-evidence-policy";
import { sql, type SQL } from "drizzle-orm";

// Alias-qualified columns preserve correlation when Drizzle compiles a
// single-table selection and would otherwise strip its table qualifiers.
const column = (alias: string, name: string) =>
  sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

const categoryPolicy = (
  categoryId: SQL,
  field: "evidenceExpectation" | "productExpectation",
) => sql`(
  SELECT ${column("ep_category", field)} FROM "SpendingCategory" ep_category
  WHERE ep_category.id = ${categoryId} AND ep_category."deletedAt" IS NULL
)`;

export const effectiveExpenseSpendingCategorySql = (
  alias: string,
): SQL => sql`COALESCE(
  ${column(alias, "spendingCategoryId")},
  (SELECT ep_purchase."spendingCategoryId" FROM "Purchase" ep_purchase
   WHERE ep_purchase.id = ${column(alias, "purchaseId")} AND ep_purchase."deletedAt" IS NULL)
)`;

export const purchaseEvidenceExpectationSql = (
  alias: string,
  transactionOverride?: SQL,
): SQL => sql`COALESCE(
  ${transactionOverride ?? sql`NULL`},
  ${column(alias, "evidenceExpectation")},
  (SELECT ep_vendor."evidenceExpectation" FROM "Vendor" ep_vendor
   WHERE ep_vendor.id = ${column(alias, "vendorId")} AND ep_vendor."deletedAt" IS NULL),
  ${categoryPolicy(column(alias, "spendingCategoryId"), "evidenceExpectation")},
  'unknown'
)`;

export const purchaseHasPrimaryDocumentSql = (
  alias: string,
): SQL => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" ep_document
  JOIN "Image" ep_image ON ep_image.id = ep_document."imageId" AND ep_image."deletedAt" IS NULL
  WHERE ep_document."entityId" = ${column(alias, "id")} AND ep_document."deletedAt" IS NULL
    AND ep_document."documentKind" IN (${sql.join(
      primaryPurchaseDocumentKinds.map((kind) => sql`${kind}`),
      sql`, `,
    )})
)`;

export const purchaseHasItemizationSql = (alias: string): SQL => sql`(
  ${column(alias, "itemizationEvidence")} = true
  AND EXISTS (SELECT 1 FROM "Expense" ep_line
    WHERE ep_line."purchaseId" = ${column(alias, "id")} AND ep_line."deletedAt" IS NULL
      AND ep_line."economicRole" = 'vendor' AND ep_line."lineBasis" = 'item_line')
  AND NOT EXISTS (SELECT 1 FROM "Expense" ep_lump
    WHERE ep_lump."purchaseId" = ${column(alias, "id")} AND ep_lump."deletedAt" IS NULL
      AND ep_lump."economicRole" = 'vendor' AND ep_lump."lineBasis" = 'allocation')
)`;

/** An accepted missing-evidence gap reopens when new documents or ledger lines
 * arrive, even when the new material still needs extraction or review. */
export const purchaseEvidenceFingerprintSql = (
  alias: string,
): SQL => sql`jsonb_build_object(
  'expectation', ${purchaseEvidenceExpectationSql(alias)},
  'itemizationEvidence', ${column(alias, "itemizationEvidence")},
  'primaryDocument', ${purchaseHasPrimaryDocumentSql(alias)},
  'documents', (SELECT jsonb_agg(jsonb_build_array(ep_changed_document.id, ep_changed_document."imageId", ep_changed_document."documentKind") ORDER BY ep_changed_document.id)
    FROM "EntityAttachment" ep_changed_document
    WHERE ep_changed_document."entityId" = ${column(alias, "id")} AND ep_changed_document."deletedAt" IS NULL),
  'lines', (SELECT jsonb_agg(to_jsonb(ep_changed_line) ORDER BY ep_changed_line.id)
    FROM "Expense" ep_changed_line WHERE ep_changed_line."purchaseId" = ${column(alias, "id")}
      AND ep_changed_line."deletedAt" IS NULL AND ep_changed_line."economicRole" = 'vendor')
)`;

const expenseProductExpectationSql = (alias: string): SQL => sql`(CASE
  WHEN ${column(alias, "economicRole")} <> 'vendor'
    OR ${column(alias, "lineKind")} <> 'principal'
    OR ${column(alias, "lineBasis")} <> 'item_line' THEN 'not_expected'
  WHEN ${column(alias, "productId")} IS NOT NULL THEN 'required'
  ELSE COALESCE(${categoryPolicy(effectiveExpenseSpendingCategorySql(alias), "productExpectation")}, 'unknown') END)`;

export const expenseProductExpectedSql = (alias: string): SQL =>
  sql`(${expenseProductExpectationSql(alias)} = 'required')`;

export const purchaseBookingSql = (alias: string): SQL => sql`(SELECT CASE
  WHEN count(*) = 0 THEN 'missing'
  WHEN count(*) FILTER (WHERE ep_book.cost IS NULL) > 0 THEN 'partial'
  ELSE 'recorded' END
  FROM "Expense" ep_book WHERE ep_book."purchaseId" = ${column(alias, "id")}
    AND ep_book."deletedAt" IS NULL AND ep_book.future = false
)`;

const evidencePresence = (present: SQL, expectation: SQL): SQL => sql`(CASE
  WHEN ${present} THEN 'present'
  WHEN ${expectation} = 'required' THEN 'missing'
  WHEN ${expectation} = 'not_expected' THEN 'not_expected'
  ELSE 'unknown' END)`;

const purchaseProductsSql = (alias: string): SQL => sql`(SELECT CASE
  WHEN count(*) FILTER (WHERE ${expenseProductExpectedSql("ep_goods")} AND ep_goods."productId" IS NULL) > 0
    THEN CASE WHEN count(*) FILTER (WHERE ${expenseProductExpectedSql("ep_goods")} AND ep_goods."productId" IS NOT NULL) > 0
      THEN 'partial' ELSE 'missing' END
  WHEN count(*) FILTER (WHERE ${expenseProductExpectationSql("ep_goods")} = 'unknown') > 0 THEN 'unknown'
  WHEN count(*) FILTER (WHERE ${expenseProductExpectedSql("ep_goods")}) > 0 THEN 'present'
  ELSE 'not_expected' END
  FROM "Expense" ep_goods WHERE ep_goods."purchaseId" = ${column(alias, "id")}
    AND ep_goods."deletedAt" IS NULL
)`;

export const purchaseCoverageSql = (
  alias: string,
  transactionOverride?: SQL,
): SQL<PurchaseEvidenceCoverage> => {
  const expectation = purchaseEvidenceExpectationSql(
    alias,
    transactionOverride,
  );
  return sql<PurchaseEvidenceCoverage>`jsonb_build_object(
    'expectation', ${expectation},
    'booking', ${purchaseBookingSql(alias)},
    'document', ${evidencePresence(purchaseHasPrimaryDocumentSql(alias), expectation)},
    'itemization', ${evidencePresence(purchaseHasItemizationSql(alias), expectation)},
    'products', ${purchaseProductsSql(alias)}
  )`;
};

export const financialTransactionRequiresBookingSql = (
  alias: string,
): SQL => sql`(
  ${column(alias, "status")} = 'posted'
  AND ${column(alias, "ledgerTransferId")} IS NULL
  AND (${column(alias, "kind")} IN ('purchase', 'refund', 'adjustment', 'fee', 'interest')
    OR (${column(alias, "kind")} = 'income' AND EXISTS (
      SELECT 1 FROM "FinancialTransactionAllocation" ep_income
      WHERE ep_income."transactionId" = ${column(alias, "id")} AND ep_income."deletedAt" IS NULL)))
)`;

// Reviewed reimbursement ownership, not the sign or provider's income label,
// establishes that a credit is household evidence rather than vendor evidence.
const financialTransactionIsReimbursementSql = (alias: string): SQL => sql`(
  SELECT count(*) > 0 AND bool_and(ep_reimbursement."economicRole" = 'reimbursement')
  FROM "Expense" ep_reimbursement
  WHERE ep_reimbursement."bookingTransactionCode" = ${column(alias, "shortcode")}
    AND ep_reimbursement."deletedAt" IS NULL
)`;

export const financialTransactionEvidenceExpectationSql = (
  alias: string,
): SQL => sql`CASE WHEN ${financialTransactionIsReimbursementSql(alias)} THEN 'not_expected' ELSE COALESCE(
  ${column(alias, "evidenceExpectation")},
  (SELECT CASE
    WHEN bool_or(${purchaseEvidenceExpectationSql("ep_linked")} = 'required') THEN 'required'
    WHEN bool_or(${purchaseEvidenceExpectationSql("ep_linked")} = 'unknown') THEN 'unknown'
    WHEN count(*) > 0 THEN 'not_expected' ELSE NULL END
   FROM "FinancialTransactionAllocation" ep_allocation
   JOIN "Purchase" ep_linked ON ep_linked.id = ep_allocation."purchaseId" AND ep_linked."deletedAt" IS NULL
   WHERE ep_allocation."transactionId" = ${column(alias, "id")} AND ep_allocation."deletedAt" IS NULL),
  ${categoryPolicy(column(alias, "spendingCategoryId"), "evidenceExpectation")}, 'unknown'
) END`;

export const financialTransactionBookingSql = (alias: string): SQL => sql`(CASE
  WHEN ${column(alias, "kind")} = 'other' AND ${column(alias, "status")} <> 'void' THEN 'unclassified'
  WHEN NOT ${financialTransactionRequiresBookingSql(alias)} THEN 'not_applicable'
  ELSE (SELECT CASE
    WHEN count(*) = 0 THEN 'missing'
    WHEN bool_and(${purchaseBookingSql("ep_booked")} = 'missing') THEN 'missing'
    WHEN bool_and(${purchaseBookingSql("ep_booked")} = 'recorded') THEN 'recorded'
    ELSE 'partial' END
    FROM "FinancialTransactionAllocation" ep_alloc
    JOIN "Purchase" ep_booked ON ep_booked.id = ep_alloc."purchaseId" AND ep_booked."deletedAt" IS NULL
    WHERE ep_alloc."transactionId" = ${column(alias, "id")} AND ep_alloc."deletedAt" IS NULL)
  END)`;

/** Each allocated Purchase keeps its own policy; a present optional receipt
 * cannot satisfy a different Purchase's required receipt. */
export const financialTransactionCoverageAxisSql = (
  alias: string,
  axis: "document" | "itemization" | "products",
): SQL => {
  const expectation = purchaseEvidenceExpectationSql(
    "ep_axis_purchase",
    column(alias, "evidenceExpectation"),
  );
  const purchaseAxis =
    axis === "products"
      ? purchaseProductsSql("ep_axis_purchase")
      : evidencePresence(
          axis === "document"
            ? purchaseHasPrimaryDocumentSql("ep_axis_purchase")
            : purchaseHasItemizationSql("ep_axis_purchase"),
          expectation,
        );
  const unallocated =
    axis === "products"
      ? sql`'not_expected'`
      : sql`CASE WHEN ${financialTransactionRequiresBookingSql(alias)}
        THEN ${evidencePresence(sql`false`, financialTransactionEvidenceExpectationSql(alias))}
        ELSE 'not_expected' END`;
  return sql`(
  SELECT CASE
    WHEN ${financialTransactionIsReimbursementSql(alias)} THEN 'not_expected'
    WHEN count(*) = 0 THEN ${unallocated}
    WHEN bool_or(ep_axis.value = 'partial') THEN 'partial'
    WHEN bool_or(ep_axis.value = 'missing') AND bool_or(ep_axis.value = 'present') THEN 'partial'
    WHEN bool_or(ep_axis.value = 'missing') THEN 'missing'
    WHEN bool_or(ep_axis.value = 'unknown') THEN 'unknown'
    WHEN bool_or(ep_axis.value = 'present') THEN 'present'
    ELSE 'not_expected' END
  FROM (
    SELECT ${purchaseAxis} AS value
    FROM "FinancialTransactionAllocation" ep_axis_allocation
    JOIN "Purchase" ep_axis_purchase ON ep_axis_purchase.id = ep_axis_allocation."purchaseId"
      AND ep_axis_purchase."deletedAt" IS NULL
    WHERE ep_axis_allocation."transactionId" = ${column(alias, "id")}
      AND ep_axis_allocation."deletedAt" IS NULL
  ) ep_axis
)`;
};

export const financialTransactionEvidenceFingerprintSql = (
  alias: string,
): SQL => sql`(
  SELECT jsonb_agg(jsonb_build_object('purchaseId', ep_fingerprint_purchase.id, 'amount', ep_fingerprint_allocation.amount,
    'evidence', ${purchaseEvidenceFingerprintSql("ep_fingerprint_purchase")}) ORDER BY ep_fingerprint_purchase.id)
  FROM "FinancialTransactionAllocation" ep_fingerprint_allocation
  JOIN "Purchase" ep_fingerprint_purchase ON ep_fingerprint_purchase.id = ep_fingerprint_allocation."purchaseId" AND ep_fingerprint_purchase."deletedAt" IS NULL
  WHERE ep_fingerprint_allocation."transactionId" = ${column(alias, "id")} AND ep_fingerprint_allocation."deletedAt" IS NULL
)`;

export const financialTransactionCoverageSql = (
  alias: string,
): SQL<FinancialTransactionCoverage> => sql<FinancialTransactionCoverage>`jsonb_build_object(
  'expectation', ${financialTransactionEvidenceExpectationSql(alias)},
  'booking', ${financialTransactionBookingSql(alias)},
  'document', ${financialTransactionCoverageAxisSql(alias, "document")},
  'itemization', ${financialTransactionCoverageAxisSql(alias, "itemization")},
  'products', ${financialTransactionCoverageAxisSql(alias, "products")}
)`;
