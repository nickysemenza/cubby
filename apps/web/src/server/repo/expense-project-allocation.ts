import type {
  ExpenseId,
  ProjectId,
  PurchaseId,
  SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/repo/database-helpers";

import {
  effectiveExpenseSpendingCategorySql,
  storedExpenseSpendingCategorySql,
  spendingCategoryCatalogSql,
  type ExpenseSpendingCategoryResolutionDraft,
} from "./expense-category-resolution";
import { effectiveExpenseProjectSql } from "./expense-inheritance";

export type ExpenseProjectAllocationBasis =
  | "principal"
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
  expenseIds?: readonly ExpenseId[] | SQL,
  draft?: ExpenseSpendingCategoryResolutionDraft,
  { categories = true }: { categories?: boolean } = {},
): SQL => sql`
  WITH ${
    expenseIds
      ? sql`selected_expense AS (
    SELECT target."id", target."purchaseId" FROM "Expense" target
    WHERE target."deletedAt" IS NULL AND target."id" = ANY(${uuidArrayParam(expenseIds)})
  ),`
      : sql``
  } principal_fact AS (
    SELECT e."id" AS "expenseId", e."purchaseId",
      ${effectiveExpenseProjectSql("e")} AS "projectId",
      ${
        // Resolving a principal line's category walks its product's category
        // ancestry per row; a project-only read skips it (~10x on the ledger).
        categories
          ? effectiveExpenseSpendingCategorySql("e", draft)
          : sql`NULL::uuid`
      } AS "spendingCategoryId",
      round(e."cost"::numeric * 100)::bigint AS cost_cents,
      live_purchase."id" IS NOT NULL AS live_purchase
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
    LEFT JOIN "Purchase" live_purchase
      ON live_purchase."id" = e."purchaseId" AND live_purchase."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL AND e."lineKind" = 'principal'
  ), purchase_direction AS (
    SELECT "purchaseId", coalesce(bool_or(cost_cents > 0), false) AS has_positive,
      coalesce(bool_or(cost_cents < 0), false) AS has_negative,
      bool_or(cost_cents IS NULL) AS has_unpriced_principal
    FROM principal_fact WHERE live_purchase GROUP BY "purchaseId"
  ), principal_weight AS (
    SELECT f."purchaseId", f."expenseId" AS "principalExpenseId",
      f."projectId", f."spendingCategoryId",
      CASE WHEN d.has_positive THEN 'positive' ELSE 'refund' END::text AS basis,
      abs(f.cost_cents)::bigint AS weight
    FROM principal_fact f JOIN purchase_direction d USING ("purchaseId")
    WHERE (d.has_positive AND f.cost_cents > 0)
      OR (NOT d.has_positive AND d.has_negative AND f.cost_cents < 0)
  ), fallback_weight AS (
    SELECT p."id" AS "purchaseId", NULL::uuid AS "principalExpenseId",
      default_project."id" AS "projectId", NULL::uuid AS "spendingCategoryId",
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
        WHEN explicit_category."id" IS NOT NULL THEN explicit_category."id"
        WHEN e."cost" < 0 AND e."lineKind" <> 'discount' AND coalesce(d.has_positive, false) THEN NULL
        ELSE w."spendingCategoryId"
      END AS "spendingCategoryId",
      coalesce(w.basis, 'default') AS basis, coalesce(w.weight, 1::bigint) AS weight,
      round(e."cost"::numeric * 100)::bigint AS source_cents,
      sum(coalesce(w.weight, 1::bigint)) OVER (PARTITION BY e."id") AS total_weight,
      explicit_category."id" IS NOT NULL AS has_explicit_category,
      coalesce(d.has_unpriced_principal, false) AS has_unpriced_principal
    FROM "Expense" e LEFT JOIN "Purchase" p
      ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
    LEFT JOIN weights w ON w."purchaseId" = p."id"
    LEFT JOIN purchase_direction d ON d."purchaseId" = p."id"
    LEFT JOIN "Project" standalone_project
      ON standalone_project."id" = e."projectId" AND standalone_project."deletedAt" IS NULL
    LEFT JOIN ${spendingCategoryCatalogSql(draft)} explicit_category
      ON explicit_category."id" = ${storedExpenseSpendingCategorySql("e", draft)} AND explicit_category."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL AND e."lineKind" <> 'principal'
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
      f."projectId", f."spendingCategoryId", f.cost_cents AS source_cents,
      f.cost_cents AS attributed_cents, 'principal'::text AS basis,
      f.cost_cents IS NULL AS incomplete,
      f."spendingCategoryId" IS NULL AS category_incomplete
    FROM principal_fact f
    UNION ALL
    SELECT r."expenseId", r."purchaseId", r."principalExpenseId", r."projectId", r."spendingCategoryId",
      r.source_cents, CASE WHEN r.source_cents IS NULL THEN NULL ELSE
        sign(r.source_cents) * (r.base_cents + CASE
          WHEN r.remainder_rank <= abs(r.source_cents) - r.assigned_cents THEN 1 ELSE 0 END)
      END::bigint AS attributed_cents, r.basis,
      r.source_cents IS NULL OR r.basis = 'default' OR r.has_unpriced_principal AS incomplete,
      r."spendingCategoryId" IS NULL OR
        (NOT r.has_explicit_category AND (r.basis = 'default' OR r.has_unpriced_principal)) AS category_incomplete
    FROM adjustment_ranked r
  )
  SELECT a."expenseId", a."purchaseId", a."principalExpenseId", a."projectId",
    p."shortcode" AS "projectShortcode", p."name" AS "projectName",
    a."spendingCategoryId", c."shortcode" AS "spendingCategoryShortcode", c."name" AS "spendingCategoryName",
    a.source_cents::text AS "sourceCents", a.attributed_cents::text AS "attributedCents",
    a.basis, a.incomplete, a.category_incomplete AS "categoryIncomplete"
  FROM allocated a
  LEFT JOIN "Project" p ON p."id" = a."projectId" AND p."deletedAt" IS NULL
  LEFT JOIN ${spendingCategoryCatalogSql(draft)} c ON c."id" = a."spendingCategoryId" AND c."deletedAt" IS NULL
  ${expenseIds ? sql`WHERE a."expenseId" IN (SELECT "id" FROM selected_expense)` : sql``}
`;

/** Project summaries group the canonical line allocations only after rounding. */
export const expenseProjectAllocationSql = (
  expenseIds?: readonly ExpenseId[],
): SQL => sql`
  SELECT a."expenseId", a."purchaseId", a."projectId", a."projectShortcode", a."projectName",
    max(a."sourceCents"::bigint)::text AS "sourceCents",
    sum(a."attributedCents"::bigint)::text AS "attributedCents",
    a.basis, bool_or(a.incomplete) AS incomplete
  FROM (${expenseJointAllocationSql(expenseIds, undefined, { categories: false })}) a
  GROUP BY a."expenseId", a."purchaseId", a."projectId", a."projectShortcode", a."projectName", a.basis
`;

export type ExpenseAllocationProjectScope = {
  projectIds?: readonly ProjectId[];
  presence?: "has" | "none";
  spendingCategoryIds?: readonly SpendingCategoryId[];
  categoryPresence?: "has" | "none";
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
  return projectCondition && categoryCondition
    ? sql`(${projectCondition} AND ${categoryCondition})`
    : (projectCondition ?? categoryCondition);
};

/** Search retains every attributed project while keeping one expense document. */
export const expenseProjectNamesSql = (
  expenseId: SQL,
): SQL<string | null> => sql`(
  SELECT string_agg(DISTINCT allocation."projectName", ', ' ORDER BY allocation."projectName")
  FROM (${expenseProjectAllocationSql()}) allocation
  WHERE allocation."expenseId" = ${expenseId}
)`;

/** Project-membership predicate backed by the same canonical allocation relation. */
export const expenseAllocationExistsSql = (
  expenseId: SQL,
  scope: ExpenseAllocationProjectScope,
): SQL => {
  const scopeCondition = expenseAllocationScopeConditionSql(
    "allocation",
    scope,
  );
  return sql`EXISTS (
    SELECT 1 FROM (${expenseJointAllocationSql()}) allocation
    WHERE allocation."expenseId" = ${expenseId}
      ${scopeCondition ? sql`AND ${scopeCondition}` : sql``}
  )`;
};

/** Attributed dollar amount for one Expense under a project scope. */
export const expenseAllocatedCostSql = (
  expenseId: SQL,
  scope: ExpenseAllocationProjectScope,
): SQL<number | null> => {
  const scopeCondition = expenseAllocationScopeConditionSql(
    "allocation",
    scope,
  );
  return sql<number | null>`(
    SELECT (sum(allocation."attributedCents"::bigint) / 100.0)::double precision
    FROM (${expenseJointAllocationSql()}) allocation
    WHERE allocation."expenseId" = ${expenseId}
      ${scopeCondition ? sql`AND ${scopeCondition}` : sql``}
  )`;
};

export async function loadExpenseProjectAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
): Promise<ExpenseProjectAllocationRow[]> {
  const result = await unwrapDb(db).execute<
    RawAllocationRow<ExpenseProjectAllocationRow>
  >(expenseProjectAllocationSql(expenseIds));
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
  const result = await unwrapDb(db).execute<
    RawAllocationRow<ExpenseJointAllocationRow>
  >(expenseJointAllocationSql(expenseIds, draft));
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
