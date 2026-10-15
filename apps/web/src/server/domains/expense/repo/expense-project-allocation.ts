import type { CostType } from "@cubby/schemas/expense-fields";
import { expenseLineKindSchema } from "@cubby/schemas/expense-line-kind";
import type {
  ExpenseId,
  ProjectId,
  PurchaseId,
  SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/project";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";

import {
  effectiveExpenseSpendingCategoriesSql,
  spendingCategoryCatalogSql,
  type ExpenseSpendingCategoryResolutionDraft,
} from "./expense-category-resolution";
import {
  effectiveExpenseProjectSql,
  effectiveExpenseTradeSql,
} from "./expense-inheritance";

/** SQL arrays retain legacy correlated callers; relational selections expose
 * cardinality to the planner instead of hiding a whole ledger in an InitPlan. */
export type ExpenseIdRelation = { select: SQL };
export type ExpenseIdSelection = readonly ExpenseId[] | SQL | ExpenseIdRelation;

export const expenseSelectionConditionSql = (
  id: SQL,
  selection: ExpenseIdSelection,
): SQL =>
  "select" in selection
    ? sql`${id} IN (${selection.select})`
    : sql`${id} = ANY(${uuidArrayParam(selection)})`;

export const expenseSelectionIdsSql = (selection: ExpenseIdSelection): SQL =>
  "select" in selection
    ? selection.select
    : sql`SELECT unnest(${uuidArrayParam(selection)}) AS id`;

export type ExpenseProjectAllocationBasis =
  | "principal"
  | "unclassified"
  | "positive"
  | "refund"
  | "default";

export type ExpenseProjectAllocationRow = {
  expenseId: ExpenseId;
  purchaseId: PurchaseId | null;
  projectId: ProjectId | null;
  projectShortcode: string | null;
  projectName: string | null;
  sourceCents: bigint | null;
  attributedCents: bigint | null;
  basis: ExpenseProjectAllocationBasis;
  incomplete: boolean;
};

export type ExpenseJointAllocationRow = ExpenseProjectAllocationRow & {
  principalExpenseId: ExpenseId | null;
  spendingCategoryId: SpendingCategoryId | null;
  spendingCategoryShortcode: string | null;
  spendingCategoryName: string | null;
  categoryIncomplete: boolean;
  /** The share's trade and cost type: its principal's, unless the adjustment
   * names its own trade. A share with no principal keeps a null trade and the
   * adjustment's own cost type. Trade is null on a project-only read. */
  trade: Trade | null;
  costType: CostType;
};

type RawAllocationRow<T> = Omit<T, "sourceCents" | "attributedCents"> & {
  sourceCents: string | number | null;
  attributedCents: string | number | null;
};

/**
 * Round shared adjustments once per principal line, before grouping dimensions.
 * All live siblings supply the denominator; ledger filters only select final
 * rows. The stable principal ID breaks remainder ties independently of mutable
 * Project/category assignments. ID-scoped reads first select complete purchases.
 */
export const expenseJointAllocationSql = (
  expenseIds?: ExpenseIdSelection,
  draft?: ExpenseSpendingCategoryResolutionDraft,
  { categories = true }: { categories?: boolean } = {},
): SQL => sql`
  WITH ${
    expenseIds
      ? sql`selected_expense AS (
    SELECT target."id", target."purchaseId" FROM "Expense" target
    WHERE target."deletedAt" IS NULL AND ${expenseSelectionConditionSql(sql`target."id"`, expenseIds)}
  ),`
      : sql``
  } principal_input AS (
    SELECT e.id, e."purchaseId", e."projectId", e."productId", e."spendingCategoryId",
      e."lineKind", e.trade, e."costType", e.cost
    FROM ${
      expenseIds
        ? sql`(
      SELECT sibling.* FROM "Expense" sibling
      WHERE sibling."deletedAt" IS NULL
        AND sibling."purchaseId" IN (SELECT "purchaseId" FROM selected_expense)
      UNION ALL
      SELECT standalone.* FROM "Expense" standalone
      WHERE standalone."deletedAt" IS NULL AND standalone."purchaseId" IS NULL
        AND standalone."id" IN (SELECT "id" FROM selected_expense)
    )`
        : sql`"Expense"`
    } e
    WHERE e."deletedAt" IS NULL AND e."lineKind" = 'principal'
  ), ${
    categories
      ? sql`principal_categories AS (
    ${effectiveExpenseSpendingCategoriesSql(sql`principal_input`, draft)}
  ),`
      : sql``
  } principal_fact AS (
    SELECT e."id" AS "expenseId", e."purchaseId",
      ${effectiveExpenseProjectSql("e")} AS "projectId",
      ${
        // Resolve policy with set-based joins across the selected principals.
        // Project-only reads omit category resolution entirely.
        categories
          ? sql`principal_categories."spendingCategoryId"`
          : sql`NULL::uuid`
      } AS "spendingCategoryId",
      ${categories ? effectiveExpenseTradeSql("e") : sql`NULL::text`} AS trade,
      e."costType"::text AS "costType",
      round(e."cost"::numeric * 100)::bigint AS cost_cents,
      live_purchase."id" IS NOT NULL AS live_purchase,
      EXISTS (SELECT 1 FROM "Expense" unknown_role
        WHERE unknown_role."purchaseId" = e."purchaseId"
          AND unknown_role."deletedAt" IS NULL
          AND unknown_role."lineKind" = ${expenseLineKindSchema.enum.unclassified}) AS has_unclassified
    FROM principal_input e
    ${categories ? sql`LEFT JOIN principal_categories ON principal_categories."expenseId"=e.id` : sql``}
    LEFT JOIN "Purchase" live_purchase
      ON live_purchase."id" = e."purchaseId" AND live_purchase."deletedAt" IS NULL
  ), purchase_direction AS (
    SELECT "purchaseId", coalesce(bool_or(cost_cents > 0), false) AS has_positive,
      coalesce(bool_or(cost_cents < 0), false) AS has_negative,
      bool_or(cost_cents IS NULL) AS has_unpriced_principal,
      coalesce(bool_or(has_unclassified), false) AS has_unclassified
    FROM principal_fact WHERE live_purchase GROUP BY "purchaseId"
  ), principal_weight AS (
    SELECT f."purchaseId", f."expenseId" AS "principalExpenseId",
      f."projectId", f."spendingCategoryId", f.trade, f."costType",
      CASE WHEN d.has_negative AND NOT d.has_positive THEN 'refund' ELSE 'positive' END::text AS basis,
      greatest(abs(f.cost_cents), 1)::bigint AS weight
    FROM principal_fact f JOIN purchase_direction d USING ("purchaseId")
    WHERE (d.has_positive AND f.cost_cents > 0)
      OR (NOT d.has_positive AND d.has_negative AND f.cost_cents < 0)
      -- Every principal priced at $0 (an award ticket, a free item that still
      -- shipped): the known zero weights split adjustments evenly. Any unpriced
      -- principal keeps the unknown default instead of inventing a denominator.
      OR (NOT d.has_positive AND NOT d.has_negative
        AND NOT coalesce(d.has_unpriced_principal, false) AND f.cost_cents = 0)
  ), fallback_weight AS (
    SELECT p."id" AS "purchaseId", NULL::uuid AS "principalExpenseId",
      default_project."id" AS "projectId", NULL::uuid AS "spendingCategoryId",
      NULL::text AS trade, NULL::text AS "costType",
      'default'::text AS basis, 1::bigint AS weight
    FROM "Purchase" p LEFT JOIN "Project" default_project
      ON default_project."id" = p."defaultProjectId" AND default_project."deletedAt" IS NULL
    WHERE p."deletedAt" IS NULL
      ${expenseIds ? sql`AND p."id" IN (SELECT "purchaseId" FROM selected_expense)` : sql``}
      AND NOT EXISTS (SELECT 1 FROM principal_weight w WHERE w."purchaseId" = p."id")
  ), weights AS (
    SELECT * FROM principal_weight UNION ALL SELECT * FROM fallback_weight
  ), adjustment_seed AS (
    SELECT e."id" AS "expenseId", e."purchaseId", w."principalExpenseId",
      CASE WHEN p."id" IS NULL THEN standalone_project."id" ELSE w."projectId" END AS "projectId",
      CASE
        WHEN e."cost" < 0 AND e."lineKind" <> 'discount' AND coalesce(d.has_positive, false) THEN NULL
        ELSE w."spendingCategoryId"
      END AS "spendingCategoryId",
      -- A trade typed onto the adjustment claims the whole charge at the
      -- adjustment's own cost type; otherwise each share follows its principal.
      -- A share with no principal to follow keeps no trade but the
      -- adjustment's own cost type.
      CASE WHEN e."trade" IS NOT NULL THEN e."trade"::text ELSE w.trade END AS trade,
      CASE WHEN e."trade" IS NOT NULL OR w."costType" IS NULL THEN e."costType"::text
        ELSE w."costType" END AS "costType",
      coalesce(w.basis, 'default') AS basis, coalesce(w.weight, 1::bigint) AS weight,
      round(e."cost"::numeric * 100)::bigint AS source_cents,
      sum(coalesce(w.weight, 1::bigint)) OVER (PARTITION BY e."id") AS total_weight,
      coalesce(d.has_unpriced_principal, false) AS has_unpriced_principal,
      coalesce(d.has_unclassified, false) AS has_unclassified
    FROM "Expense" e LEFT JOIN "Purchase" p
      ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
    LEFT JOIN weights w ON w."purchaseId" = p."id"
    LEFT JOIN purchase_direction d ON d."purchaseId" = p."id"
    LEFT JOIN "Project" standalone_project
      ON standalone_project."id" = e."projectId" AND standalone_project."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL AND e."lineKind" NOT IN ('principal', ${expenseLineKindSchema.enum.unclassified})
      ${expenseIds ? sql`AND e."id" IN (SELECT "id" FROM selected_expense)` : sql``}
  ), adjustment_floor AS (
    SELECT *, CASE WHEN source_cents IS NULL THEN NULL ELSE
      floor(abs(source_cents)::numeric * weight::numeric / total_weight)::bigint END AS base_cents,
      CASE WHEN source_cents IS NULL THEN NULL ELSE
        mod(abs(source_cents)::numeric * weight::numeric, total_weight) END AS fractional_rank
    FROM adjustment_seed
  ), adjustment_ranked AS (
    SELECT *, sum(base_cents) OVER (PARTITION BY "expenseId") AS assigned_cents,
      row_number() OVER (PARTITION BY "expenseId"
        ORDER BY fractional_rank DESC NULLS LAST, "principalExpenseId" ASC NULLS LAST) AS remainder_rank
    FROM adjustment_floor
  ), allocated AS (
    SELECT f."expenseId", f."purchaseId", f."expenseId" AS "principalExpenseId",
      f."projectId", f."spendingCategoryId", f.trade, f."costType", f.cost_cents AS source_cents,
      f.cost_cents AS attributed_cents, 'principal'::text AS basis,
      f.cost_cents IS NULL OR coalesce(d.has_unclassified, false) AS incomplete,
      f."spendingCategoryId" IS NULL OR coalesce(d.has_unclassified, false) AS category_incomplete
    FROM principal_fact f LEFT JOIN purchase_direction d USING ("purchaseId")
    UNION ALL
    SELECT e."id" AS "expenseId", e."purchaseId", NULL::uuid AS "principalExpenseId",
      NULL::uuid AS "projectId", NULL::uuid AS "spendingCategoryId",
      NULL::text AS trade, e."costType"::text AS "costType",
      round(e."cost"::numeric * 100)::bigint AS source_cents,
      round(e."cost"::numeric * 100)::bigint AS attributed_cents,
      ${expenseLineKindSchema.enum.unclassified}::text AS basis, true AS incomplete, true AS category_incomplete
    FROM "Expense" e
    WHERE e."deletedAt" IS NULL AND e."lineKind" = ${expenseLineKindSchema.enum.unclassified}
      ${expenseIds ? sql`AND e."id" IN (SELECT "id" FROM selected_expense)` : sql``}
    UNION ALL
    SELECT r."expenseId", r."purchaseId", r."principalExpenseId", r."projectId", r."spendingCategoryId",
      r.trade, r."costType", r.source_cents, CASE WHEN r.source_cents IS NULL THEN NULL ELSE
        sign(r.source_cents) * (r.base_cents + CASE
          WHEN r.remainder_rank <= abs(r.source_cents) - r.assigned_cents THEN 1 ELSE 0 END)
      END::bigint AS attributed_cents, r.basis,
      r.source_cents IS NULL OR r.basis = 'default' OR r.has_unpriced_principal OR r.has_unclassified AS incomplete,
      r."spendingCategoryId" IS NULL OR r.basis = 'default' OR r.has_unpriced_principal OR r.has_unclassified AS category_incomplete
    FROM adjustment_ranked r
  )
  SELECT a."expenseId", a."purchaseId", a."principalExpenseId", a."projectId",
    p."shortcode" AS "projectShortcode", p."name" AS "projectName",
    a."spendingCategoryId", c."shortcode" AS "spendingCategoryShortcode", c."name" AS "spendingCategoryName",
    a.source_cents::text AS "sourceCents", a.attributed_cents::text AS "attributedCents",
    a.basis, a.incomplete, a.category_incomplete AS "categoryIncomplete",
    a.trade, a."costType"
  FROM allocated a
  LEFT JOIN "Project" p ON p."id" = a."projectId" AND p."deletedAt" IS NULL
  LEFT JOIN ${spendingCategoryCatalogSql(draft)} c ON c."id" = a."spendingCategoryId" AND c."deletedAt" IS NULL
  ${expenseIds ? sql`WHERE a."expenseId" IN (SELECT "id" FROM selected_expense)` : sql``}
`;

export type ExpenseAllocationProjectScope = {
  /** Select entire expenses independently of the shares being measured. */
  membershipProjectIds?: readonly ProjectId[];
  projectIds?: readonly ProjectId[];
  presence?: "has" | "none";
  spendingCategoryIds?: readonly SpendingCategoryId[];
  categoryPresence?: "has" | "none";
  trades?: readonly Trade[];
  costTypes?: readonly CostType[];
};

export const expenseAllocationScopeConditionSql = (
  alias: string,
  scope: ExpenseAllocationProjectScope,
): SQL | undefined => {
  const allocation = sql.raw(alias);
  const projectMatch = scope.projectIds
    ? scope.projectIds.length === 0
      ? sql`false`
      : sql`${allocation}."projectId" = ANY(${uuidArrayParam(scope.projectIds)})`
    : undefined;
  const presenceMatch =
    scope.presence === "has"
      ? sql`${allocation}."projectId" IS NOT NULL`
      : scope.presence === "none"
        ? sql`${allocation}."projectId" IS NULL`
        : undefined;
  const projectCondition =
    projectMatch && presenceMatch
      ? sql`(${projectMatch} OR ${presenceMatch})`
      : (projectMatch ?? presenceMatch);
  const categoryMatch = scope.spendingCategoryIds
    ? scope.spendingCategoryIds.length === 0
      ? sql`false`
      : sql`${allocation}."spendingCategoryId" = ANY(${uuidArrayParam(scope.spendingCategoryIds)})`
    : undefined;
  const categoryPresence =
    scope.categoryPresence === "has"
      ? sql`${allocation}."spendingCategoryId" IS NOT NULL`
      : scope.categoryPresence === "none"
        ? sql`${allocation}."spendingCategoryId" IS NULL`
        : undefined;
  const categoryCondition =
    categoryMatch && categoryPresence
      ? sql`(${categoryMatch} OR ${categoryPresence})`
      : (categoryMatch ?? categoryPresence);
  const shareMatch = (column: string, values?: readonly string[]) =>
    values === undefined
      ? undefined
      : values.length === 0
        ? sql`false`
        : sql`${allocation}.${sql.raw(`"${column}"`)} IN (${sql.join(
            values.map((value) => sql`${value}`),
            sql`, `,
          )})`;
  const conditions = [
    projectCondition,
    categoryCondition,
    shareMatch("trade", scope.trades),
    shareMatch("costType", scope.costTypes),
  ].filter((condition) => condition !== undefined);
  return conditions.length === 0
    ? undefined
    : sql`(${sql.join(conditions, sql` AND `)})`;
};

export async function loadExpenseProjectAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
): Promise<ExpenseProjectAllocationRow[]> {
  const { expenseDerivedReadSql } = await import("./expense-derived-read");
  const result = await unwrapDb(db).execute<
    RawAllocationRow<ExpenseProjectAllocationRow>
  >(expenseDerivedReadSql("projects", { expenseIds }));
  return result.rows.map((row) => ({
    ...row,
    sourceCents: row.sourceCents === null ? null : BigInt(row.sourceCents),
    attributedCents:
      row.attributedCents === null ? null : BigInt(row.attributedCents),
  }));
}

export type ExpenseJointAllocationRawRow =
  RawAllocationRow<ExpenseJointAllocationRow>;

/** Rows of `expenseJointAllocationSql`, as selected or as `to_jsonb` of one. */
export const parseExpenseJointAllocationRows = (
  rows: readonly ExpenseJointAllocationRawRow[],
): ExpenseJointAllocationRow[] =>
  rows.map((row) => ({
    ...row,
    sourceCents: row.sourceCents === null ? null : BigInt(row.sourceCents),
    attributedCents:
      row.attributedCents === null ? null : BigInt(row.attributedCents),
  }));

export async function loadExpenseJointAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
  draft?: ExpenseSpendingCategoryResolutionDraft,
): Promise<ExpenseJointAllocationRow[]> {
  const { expenseDerivedReadSql } = await import("./expense-derived-read");
  const result = await unwrapDb(db).execute<
    RawAllocationRow<ExpenseJointAllocationRow>
  >(expenseDerivedReadSql("shares", { expenseIds, draft }));
  return parseExpenseJointAllocationRows(result.rows);
}

export async function hydrateExpenseProjectAllocations<
  T extends { id: ExpenseId },
>(
  db: Database | DrizzleTransaction,
  rows: readonly T[],
): Promise<Array<T & { projectAllocations: ExpenseProjectAllocationRow[] }>> {
  const allocations = await loadExpenseProjectAllocations(
    db,
    rows.map((row) => row.id),
  );
  const byExpense = new Map<ExpenseId, ExpenseProjectAllocationRow[]>();
  for (const allocation of allocations) {
    const existing = byExpense.get(allocation.expenseId) ?? [];
    existing.push(allocation);
    byExpense.set(allocation.expenseId, existing);
  }
  return rows.map((row) => ({
    ...row,
    projectAllocations: byExpense.get(row.id) ?? [],
  }));
}
