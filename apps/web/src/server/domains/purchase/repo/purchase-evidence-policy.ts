import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { primaryPurchaseDocumentKinds } from "@cubby/schemas/purchase";
import { itemizationExpectation } from "@cubby/schemas/purchase-evidence-policy";
import type {
  FinancialTransactionCoverage,
  PurchaseEvidenceCoverage,
} from "@cubby/schemas/purchase-evidence-policy";
import { vendorOrderEvidence } from "@cubby/schemas/vendor-import-fields";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { sqlEnumConstant, unwrapDb } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
export { effectiveExpenseSpendingCategorySql } from "~/server/domains/expense/repo/expense-category-resolution";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";

// Alias-qualified columns preserve correlation when Drizzle compiles a
// single-table selection and would otherwise strip its table qualifiers.
const column = (alias: string, name: string) =>
  sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

const categoryPolicy = (
  categoryId: SQL,
  field: "itemizationExpectation" | "productExpectation",
) => sql`(
  SELECT ${column("ep_category", field)} FROM "SpendingCategory" ep_category
  WHERE ep_category.id = ${categoryId} AND ep_category."deletedAt" IS NULL
)`;

/** The itemization policy a Vendor's order evidence implies: an online
 * account keeps retrievable order history, so item lines are expected; no
 * order evidence means none are. Receipt-only and unrecorded evidence imply
 * nothing (NULL), so a Purchase still falls through to its spending category
 * rather than stopping at an unclassified Vendor. */
const vendorOrderEvidenceItemizationSql = (
  alias: string,
): SQL => sql`(CASE ${column(alias, "orderEvidence")}
  WHEN ${sqlEnumConstant(vendorOrderEvidence, vendorOrderEvidence.enum.online_account)} THEN ${sqlEnumConstant(itemizationExpectation, itemizationExpectation.enum.required)}
  WHEN ${sqlEnumConstant(vendorOrderEvidence, vendorOrderEvidence.enum.not_expected)} THEN ${sqlEnumConstant(itemizationExpectation, itemizationExpectation.enum.not_expected)} END)`;

/** A Vendor's own itemization policy: its explicit value always wins over the
 * one its order evidence implies. */
export const vendorItemizationPolicySql = (alias: string): SQL =>
  sql`COALESCE(${column(alias, "itemizationExpectation")},${vendorOrderEvidenceItemizationSql(alias)})`;

const purchaseEvidenceFallbackSql = (alias: string): SQL => sql`COALESCE(
  (SELECT ${vendorItemizationPolicySql("ep_vendor")} FROM "Vendor" ep_vendor
   WHERE ep_vendor.id = ${column(alias, "vendorId")} AND ep_vendor."deletedAt" IS NULL),
  ${categoryPolicy(column(alias, "spendingCategoryId"), "itemizationExpectation")},
  'unknown'
)`;

export const purchaseItemizationExpectationSql = (
  alias: string,
  transactionOverride?: SQL,
): SQL => sql`COALESCE(
  ${transactionOverride ?? sql`NULL`},
  ${column(alias, "itemizationExpectation")},
  ${purchaseEvidenceFallbackSql(alias)}
)`;

const categoryEvidenceSourceSql = (alias: string): SQL => sql`(
  SELECT jsonb_build_object('entityKind','spendingCategory','entityId',ep_source_category.shortcode,'name',ep_source_category.name)
  FROM "SpendingCategory" ep_source_category
  WHERE ep_source_category.id = ${column(alias, "spendingCategoryId")}
    AND ep_source_category."deletedAt" IS NULL AND ep_source_category."itemizationExpectation" IS NOT NULL
)`;

const evidenceFieldResolutionsSql = (values: {
  stored: SQL;
  value: SQL;
  fallback: SQL;
  source: SQL;
  sourceEntity: SQL;
  allocated?: SQL;
}): SQL<FieldResolutions> => sql<FieldResolutions>`(
  SELECT jsonb_build_object('itemizationExpectation',jsonb_build_object(
    'mode',CASE WHEN policy.allocated THEN 'allocated' WHEN policy.stored IS NOT NULL THEN 'explicit' ELSE 'inherit' END,
    'storedValue',policy.stored,'value',policy.value,'fallbackValue',policy.fallback,
    'source',policy.source,'sourceEntity',policy."sourceEntity",
    'matchesFallback',policy.value IS NOT DISTINCT FROM policy.fallback,'canReset',policy.stored IS NOT NULL
  )) FROM (SELECT ${values.stored} AS stored,${values.value} AS value,${values.fallback} AS fallback,
    ${values.source} AS source,${values.sourceEntity} AS "sourceEntity",${values.allocated ?? sql`false`} AS allocated) policy
)`;

/** The Vendor read's `fieldResolutions.itemizationExpectation`: the stored
 * value is the override, and the fallback is exactly what the Purchase ladder
 * reads at the Vendor rung. When order evidence implies nothing the value and
 * fallback stay NULL (labelled Unclassified), never `unknown`: an explicit
 * `unknown` stops the ladder before the spending category, so it must not
 * read as a redundant override that a reset could clear. */
export const vendorEvidenceFieldResolutionsSql = (
  alias: string,
): SQL<FieldResolutions> => {
  const stored = column(alias, "itemizationExpectation");
  const implied = vendorOrderEvidenceItemizationSql(alias);
  return evidenceFieldResolutionsSql({
    stored,
    value: vendorItemizationPolicySql(alias),
    fallback: implied,
    source: sql`CASE WHEN ${stored} IS NOT NULL THEN 'vendor override'
      WHEN ${implied} IS NOT NULL THEN 'order evidence' ELSE 'unclassified policy' END`,
    sourceEntity: sql`NULL::jsonb`,
  });
};

export const purchaseEvidenceFieldResolutionsSql = (
  alias: string,
): SQL<FieldResolutions> => {
  const vendorSource = sql`(SELECT jsonb_build_object('entityKind','vendor','entityId',ep_source_vendor.shortcode,'name',ep_source_vendor.name)
    FROM "Vendor" ep_source_vendor WHERE ep_source_vendor.id = ${column(alias, "vendorId")}
      AND ep_source_vendor."deletedAt" IS NULL AND ${vendorItemizationPolicySql("ep_source_vendor")} IS NOT NULL)`;
  const inheritedSource = sql`COALESCE(${vendorSource},${categoryEvidenceSourceSql(alias)})`;
  return evidenceFieldResolutionsSql({
    stored: column(alias, "itemizationExpectation"),
    value: purchaseItemizationExpectationSql(alias),
    fallback: purchaseEvidenceFallbackSql(alias),
    source: sql`CASE WHEN ${column(alias, "itemizationExpectation")} IS NOT NULL THEN 'purchase override'
      WHEN ${vendorSource} IS NOT NULL THEN 'vendor policy'
      WHEN ${categoryEvidenceSourceSql(alias)} IS NOT NULL THEN 'spending category policy' ELSE 'unclassified policy' END`,
    sourceEntity: inheritedSource,
  });
};

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

/** Booked as an `allocation` slice of an un-itemized total (an instalment, a
 * statement booking) rather than as the order's own lines. */
const purchaseHasAllocationSql = (alias: string): SQL => sql`EXISTS (
  SELECT 1 FROM "Expense" ep_allocation_line
  WHERE ep_allocation_line."purchaseId" = ${column(alias, "id")} AND ep_allocation_line."deletedAt" IS NULL
    AND ${sql.raw(actualExpenseSql("ep_allocation_line"))} AND ep_allocation_line."economicRole" = 'vendor'
    AND ep_allocation_line."lineBasis" = 'allocation'
)`;

/** The order's own item lines, before Product identity: at least one live,
 * incurred vendor principal `item_line` and no `allocation` slice of an
 * un-itemized total. Transaction surfaces read this shape alone because their
 * `financial_transaction_products` axis already reports unlinked goods; adding
 * the per-line Product policy here planned its category resolution twice more
 * per transaction score and broke the planner-memory budget. */
const purchaseHasItemLinesSql = (alias: string): SQL => sql`(
  EXISTS (SELECT 1 FROM "Expense" ep_line
    WHERE ep_line."purchaseId" = ${column(alias, "id")} AND ep_line."deletedAt" IS NULL
      AND ${sql.raw(actualExpenseSql("ep_line"))} AND ep_line."economicRole" = 'vendor'
      AND ep_line."lineKind" = 'principal' AND ep_line."lineBasis" = 'item_line')
  AND NOT ${purchaseHasAllocationSql(alias)}
)`;

/** Goods booked as `allocation` slices (a deposit and balance): those lines
 * never carry a Product, so the goods are recorded as `purchaseProduct`
 * links instead. */
const purchaseHasLinkedGoodsSql = (alias: string): SQL => sql`(
  ${purchaseHasAllocationSql(alias)}
  AND EXISTS (SELECT 1 FROM "EntityLink" ep_linked_goods
    JOIN "Product" ep_linked_product ON ep_linked_product.id = ep_linked_goods."toEntityId" AND ep_linked_product."deletedAt" IS NULL
    WHERE ep_linked_goods."fromEntityId" = ${column(alias, "id")} AND ep_linked_goods."deletedAt" IS NULL
      AND ep_linked_goods.kind = 'purchaseProduct')
)`;

/** The order lists its goods, before per-line Product policy: its own item
 * lines, or allocation slices with linked Products. Transaction surfaces read
 * this alone for the planner-memory reason on `purchaseHasItemLinesSql`. */
export const purchaseListsItemsSql = (alias: string): SQL => sql`(
  ${purchaseHasItemLinesSql(alias)} OR ${purchaseHasLinkedGoodsSql(alias)}
)`;

/** Each itemization line fact, stated once over an Expense line alias: the
 * record-level read probes it with EXISTS, the bulk read folds it per
 * Purchase with `bool_or`. */
const itemizationLineFacts = {
  hasUnclassified: (line: string): SQL =>
    sql`${column(line, "lineKind")} = ${expenseLineKindSchema.enum.unclassified}`,
  hasUnlinkedRequired: (line: string): SQL => unlinkedRequiredLineSql(line),
} as const;
type ItemizationLineFact = keyof typeof itemizationLineFacts;

/** A Purchase is itemized when it lists its goods and every principal line
 * whose Product is expected links one, whichever shape lists them. A single
 * productless goods line is a lump, not an itemization. Totals stay with
 * `paperwork_mismatch` and `settlement_mismatch`; this axis is the line shape
 * only. */
export const purchaseHasItemizationSql = (alias: string): SQL => {
  const fact = (name: ItemizationLineFact) =>
    sql`EXISTS (SELECT 1 FROM "Expense" ep_fact_line
    WHERE ep_fact_line."purchaseId" = ${column(alias, "id")}
      AND ep_fact_line."deletedAt" IS NULL
      AND ${itemizationLineFacts[name]("ep_fact_line")})`;
  return sql`(
  ${purchaseListsItemsSql(alias)}
  AND NOT ${fact("hasUnclassified")}
  AND NOT ${fact("hasUnlinkedRequired")}
)`;
};

// Services are labor and carry no Product by design, whatever their category;
// a service line that does link one (a software subscription) keeps it.
const expenseProductExpectationSql = (alias: string): SQL => sql`(CASE
  WHEN ${column(alias, "economicRole")} <> 'vendor'
    OR ${column(alias, "lineKind")} <> 'principal'
    OR ${column(alias, "lineBasis")} <> 'item_line' THEN 'not_expected'
  WHEN ${column(alias, "productId")} IS NOT NULL THEN 'required'
  WHEN ${column(alias, "costType")} = 'services' THEN 'not_expected'
  ELSE COALESCE(${categoryPolicy(effectiveExpenseSpendingCategorySql(alias), "productExpectation")}, 'unknown') END)`;

export const expenseProductExpectedSql = (alias: string): SQL =>
  sql`(${expenseProductExpectationSql(alias)} = 'required')`;

/** An incurred line still missing the Product its policy requires. */
const unlinkedRequiredLineSql = (alias: string): SQL =>
  sql`(${sql.raw(actualExpenseSql(alias))} AND ${column(alias, "productId")} IS NULL
    AND ${expenseProductExpectedSql(alias)})`;

const purchaseBookingSql = (alias: string): SQL => sql`(SELECT CASE
  WHEN count(*) = 0 THEN 'missing'
  WHEN count(*) FILTER (WHERE ep_book.cost IS NULL) > 0 THEN 'partial'
  ELSE 'recorded' END
  FROM "Expense" ep_book WHERE ep_book."purchaseId" = ${column(alias, "id")}
    AND ep_book."deletedAt" IS NULL AND ${sql.raw(actualExpenseSql("ep_book"))}
)`;

/** No policy requires a document: an attached receipt or invoice is useful
 * evidence when present and never a gap when absent. */
const documentPresence = (present: SQL): SQL =>
  sql`(CASE WHEN ${present} THEN 'present' ELSE 'not_expected' END)`;

/** A retained receipt or invoice is itemizable whatever the policy says: a
 * member's receipt photo enters the Research queue this way. Every itemization
 * surface (Purchase gap, coverage, transaction axis) reads this one value. */
export const effectivePurchaseItemizationExpectationSql = (
  alias: string,
  transactionOverride?: SQL,
): SQL => sql`(CASE WHEN ${purchaseHasPrimaryDocumentSql(alias)} THEN 'required'
  ELSE ${purchaseItemizationExpectationSql(alias, transactionOverride)} END)`;

const evidencePresence = (present: SQL, expectation: SQL): SQL => sql`(CASE
  WHEN ${present} THEN 'present'
  WHEN ${expectation} = 'required' THEN 'missing'
  WHEN ${expectation} = 'not_expected' THEN 'not_expected'
  ELSE 'unknown' END)`;

// Each line's expectation is evaluated once in an `OFFSET 0` fence: Postgres
// has no common-subexpression elimination, so repeating it per FILTER planned
// its category-resolution CTE four times, and this axis is itself repeated by
// every data-quality score, status, and hydration that reads it.
const purchaseProductsSql = (alias: string): SQL => sql`(SELECT CASE
  WHEN count(*) FILTER (WHERE ep_goods_policy.expectation = 'required' AND ep_goods."productId" IS NULL) > 0
    THEN CASE WHEN count(*) FILTER (WHERE ep_goods_policy.expectation = 'required' AND ep_goods."productId" IS NOT NULL) > 0
      THEN 'partial' ELSE 'missing' END
  WHEN count(*) FILTER (WHERE ep_goods_policy.expectation = 'unknown') > 0 THEN 'unknown'
  WHEN count(*) FILTER (WHERE ep_goods_policy.expectation = 'required') > 0 THEN 'present'
  ELSE 'not_expected' END
  FROM "Expense" ep_goods
  CROSS JOIN LATERAL (SELECT ${expenseProductExpectationSql("ep_goods")} AS expectation OFFSET 0) ep_goods_policy
  WHERE ep_goods."purchaseId" = ${column(alias, "id")}
    AND ep_goods."deletedAt" IS NULL
)`;

export const purchaseCoverageSql = (
  alias: string,
  transactionOverride?: SQL,
): SQL<PurchaseEvidenceCoverage> => {
  const expectation = purchaseItemizationExpectationSql(
    alias,
    transactionOverride,
  );
  return sql<PurchaseEvidenceCoverage>`jsonb_build_object(
    'expectation', ${expectation},
    'booking', ${purchaseBookingSql(alias)},
    'document', ${documentPresence(purchaseHasPrimaryDocumentSql(alias))},
    'itemization', ${evidencePresence(purchaseHasItemizationSql(alias), effectivePurchaseItemizationExpectationSql(alias, transactionOverride))},
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

export const linkedPurchaseItemizationExpectationSql = (
  alias: string,
  purchaseOverride?: SQL,
): SQL =>
  purchaseOverride !== undefined
    ? sql`(SELECT ${purchaseItemizationExpectationSql("ep_linked")} FROM "Purchase" ep_linked WHERE ep_linked.id = ${purchaseOverride} AND ep_linked."deletedAt" IS NULL)`
    : sql`(SELECT CASE
    WHEN bool_or(ep_linked_policy.expectation = 'required') THEN 'required'
    WHEN bool_or(ep_linked_policy.expectation = 'unknown') THEN 'unknown'
    WHEN count(*) > 0 THEN 'not_expected' ELSE NULL END
   FROM "FinancialTransactionAllocation" ep_allocation
   JOIN "Purchase" ep_linked ON ep_linked.id = ep_allocation."purchaseId" AND ep_linked."deletedAt" IS NULL
   CROSS JOIN LATERAL (SELECT ${purchaseItemizationExpectationSql("ep_linked")} AS expectation OFFSET 0) ep_linked_policy
   WHERE ep_allocation."transactionId" = ${column(alias, "id")} AND ep_allocation."deletedAt" IS NULL)`;

const financialTransactionPolicyExpectationSql = (
  alias: string,
  purchaseOverride?: SQL,
): SQL =>
  sql`COALESCE(${linkedPurchaseItemizationExpectationSql(alias, purchaseOverride)},${categoryPolicy(column(alias, "spendingCategoryId"), "itemizationExpectation")},'unknown')`;

const financialTransactionEvidenceFallbackSql = (
  alias: string,
  purchaseOverride?: SQL,
): SQL => sql`CASE
  WHEN ${financialTransactionIsReimbursementSql(alias)} THEN 'not_expected'
  ELSE ${financialTransactionPolicyExpectationSql(alias, purchaseOverride)} END`;

// Not `COALESCE(override, fallback)`: the fallback would re-test reimbursement
// that this CASE already excluded, and this expectation is inlined many times
// per data-quality score.
export const financialTransactionItemizationExpectationSql = (
  alias: string,
  purchaseOverride?: SQL,
): SQL => sql`CASE
  WHEN ${financialTransactionIsReimbursementSql(alias)} THEN 'not_expected'
  ELSE COALESCE(${column(alias, "itemizationExpectation")},${financialTransactionPolicyExpectationSql(alias, purchaseOverride)}) END`;

/** Aggregate policy names a source only for exactly one live linked Purchase.
 * This counts the full set, independently of any contributor disclosure limit. */
export const linkedPurchaseItemizationSourceSql = (
  alias: string,
  purchaseOverride?: SQL,
): SQL =>
  purchaseOverride !== undefined
    ? sql`(SELECT jsonb_build_object('entityKind','purchase','entityId',ep_source_purchase.shortcode,'name',ep_source_purchase."displayLabel") FROM "Purchase" ep_source_purchase WHERE ep_source_purchase.id = ${purchaseOverride} AND ep_source_purchase."deletedAt" IS NULL)`
    : sql`(SELECT CASE WHEN count(*) = 1 THEN
    jsonb_build_object('entityKind','purchase','entityId',min(ep_source_purchase.shortcode),'name',min(ep_source_purchase."displayLabel")) ELSE NULL END
    FROM "FinancialTransactionAllocation" ep_source_allocation
    JOIN "Purchase" ep_source_purchase ON ep_source_purchase.id = ep_source_allocation."purchaseId" AND ep_source_purchase."deletedAt" IS NULL
    WHERE ep_source_allocation."transactionId" = ${column(alias, "id")} AND ep_source_allocation."deletedAt" IS NULL)`;

export const financialTransactionEvidenceFieldResolutionsSql = (
  alias: string,
  purchaseOverride?: SQL,
): SQL<FieldResolutions> => {
  const reimbursed = financialTransactionIsReimbursementSql(alias);
  const linked = linkedPurchaseItemizationExpectationSql(
    alias,
    purchaseOverride,
  );

  return evidenceFieldResolutionsSql({
    stored: column(alias, "itemizationExpectation"),
    value: financialTransactionItemizationExpectationSql(
      alias,
      purchaseOverride,
    ),
    fallback: financialTransactionEvidenceFallbackSql(alias, purchaseOverride),
    allocated: reimbursed,
    source: sql`CASE WHEN ${reimbursed} THEN 'reviewed reimbursement'
      WHEN ${column(alias, "itemizationExpectation")} IS NOT NULL THEN 'transaction override'
      WHEN ${linked} IS NOT NULL THEN 'linked purchase policies'
      WHEN ${categoryEvidenceSourceSql(alias)} IS NOT NULL THEN 'spending category policy' ELSE 'unclassified policy' END`,
    sourceEntity: sql`CASE WHEN ${reimbursed} THEN NULL WHEN ${linked} IS NOT NULL THEN ${linkedPurchaseItemizationSourceSql(alias, purchaseOverride)} ELSE ${categoryEvidenceSourceSql(alias)} END`,
  });
};

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

/** Each allocated Purchase keeps its own policy; one itemized Purchase cannot
 * satisfy a different Purchase's expected itemization. */
export const financialTransactionCoverageAxisSql = (
  alias: string,
  axis: "document" | "itemization" | "products",
): SQL => {
  const purchaseAxis =
    axis === "products"
      ? purchaseProductsSql("ep_axis_purchase")
      : axis === "document"
        ? documentPresence(purchaseHasPrimaryDocumentSql("ep_axis_purchase"))
        : evidencePresence(
            purchaseListsItemsSql("ep_axis_purchase"),
            effectivePurchaseItemizationExpectationSql(
              "ep_axis_purchase",
              column(alias, "itemizationExpectation"),
            ),
          );
  const unallocated =
    axis === "itemization"
      ? sql`CASE WHEN ${financialTransactionRequiresBookingSql(alias)}
        THEN ${evidencePresence(sql`false`, financialTransactionItemizationExpectationSql(alias))}
        ELSE 'not_expected' END`
      : sql`'not_expected'`;
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

export const financialTransactionCoverageSql = (
  alias: string,
): SQL<FinancialTransactionCoverage> => sql<FinancialTransactionCoverage>`jsonb_build_object(
  'expectation', ${financialTransactionItemizationExpectationSql(alias)},
  'booking', ${financialTransactionBookingSql(alias)},
  'document', ${financialTransactionCoverageAxisSql(alias, "document")},
  'itemization', ${financialTransactionCoverageAxisSql(alias, "itemization")},
  'products', ${financialTransactionCoverageAxisSql(alias, "products")}
)`;

const draftEvidenceRow = z.object({
  id: z.string(),
  shortcode: z.string(),
  vendorId: z.string().nullable(),
  spendingCategoryId: z.string().nullable(),
  itemizationExpectation: itemizationExpectation.nullable(),
});

/** Draft policy uses the same SQL resolver as persisted reads. It never
 * mutates the source record or turns inherited policy into an override. */
async function draftPurchaseId(
  db: Database,
  id: string | null,
  basis: Readonly<Record<string, string | null | undefined>>,
): Promise<string | null | undefined> {
  const draftFields = basis.__draftFields
    ? z.array(z.string()).parse(JSON.parse(basis.__draftFields))
    : null;
  // A singular form field can be null while the saved transaction has multiple
  // allocations. Only a changed link replaces that graph during draft review.
  if (id && draftFields && !draftFields.includes("purchaseId"))
    return undefined;
  if (!Object.hasOwn(basis, "purchaseId")) return undefined;
  return basis.purchaseId
    ? resolveLiveShortcode(db, basis.purchaseId, "purchase")
    : null;
}

export async function resolveDraftEvidenceFields(
  db: Database,
  input: {
    entity: "purchase" | "financialTransaction";
    entityId?: string;
    basis: Readonly<Record<string, string | null | undefined>>;
  },
): Promise<FieldResolutions> {
  const purchase = input.entity === "purchase";
  const id = input.entityId
    ? await resolveLiveShortcode(db, input.entityId, input.entity)
    : null;
  const table = purchase ? "Purchase" : "FinancialTransaction";
  const persisted = id
    ? await unwrapDb(db).execute(sql`SELECT id,shortcode,
    ${purchase ? sql`"vendorId"` : sql`NULL::uuid`} AS "vendorId","spendingCategoryId","itemizationExpectation"
    FROM ${sql.identifier(table)} WHERE id=${id} AND "deletedAt" IS NULL`)
    : null;
  const baseline = persisted?.rows[0]
    ? draftEvidenceRow.parse(persisted.rows[0])
    : null;
  const foreignId = async (
    field: "vendorId" | "spendingCategoryId",
    entity: "vendor" | "spendingCategory",
  ) =>
    Object.hasOwn(input.basis, field)
      ? input.basis[field]
        ? resolveLiveShortcode(db, input.basis[field]!, entity)
        : null
      : (baseline?.[field] ?? null);
  const [vendorId, categoryId] = await Promise.all([
    foreignId("vendorId", "vendor"),
    foreignId("spendingCategoryId", "spendingCategory"),
  ]);
  const stored = itemizationExpectation
    .nullable()
    .parse(
      Object.hasOwn(input.basis, "itemizationExpectation")
        ? (input.basis.itemizationExpectation ?? null)
        : (baseline?.itemizationExpectation ?? null),
    );
  const purchaseId = purchase
    ? undefined
    : await draftPurchaseId(db, id, input.basis);
  const resolver = purchase
    ? purchaseEvidenceFieldResolutionsSql("ep_draft")
    : financialTransactionEvidenceFieldResolutionsSql(
        "ep_draft",
        purchaseId === undefined ? undefined : sql`${purchaseId}::uuid`,
      );
  const result = await unwrapDb(db)
    .execute(sql`SELECT ${resolver} AS resolutions FROM (SELECT
    ${id}::uuid AS id,${baseline?.shortcode ?? null}::text AS shortcode,${vendorId}::uuid AS "vendorId",
    ${categoryId}::uuid AS "spendingCategoryId",${stored}::text AS "itemizationExpectation") ep_draft`);
  return z.object({ resolutions: fieldResolutionsSchema }).parse(result.rows[0])
    .resolutions;
}
