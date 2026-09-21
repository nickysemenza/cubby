import type {
  ExpenseId,
  ProjectId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { sql, type SQL } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/repo/database-helpers";

import { effectiveExpenseProjectSql } from "./expense-inheritance";

type ExpenseProjectAllocationBasis =
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

type RawAllocationRow = Omit<
  ExpenseProjectAllocationRow,
  "sourceCents" | "attributedCents"
> & {
  sourceCents: string | number | null;
  attributedCents: string | number | null;
};

/**
 * Reusable exact-cent allocation query for Expense/project reporting.
 *
 * The weight CTE deliberately sees every live principal in a live Purchase.
 * Consumers apply date, product, project, and other ledger filters only to the
 * final rows; narrowing the denominator first would reassign tax and shipping
 * when a chart filter hides one principal line.
 */
export const expenseProjectAllocationSql = (
  expenseIds?: readonly ExpenseId[],
): SQL => sql`
  WITH principal_fact AS (
    SELECT
      e."id" AS "expenseId",
      e."purchaseId",
      ${effectiveExpenseProjectSql("e")} AS "projectId",
      round((e."cost")::numeric * 100)::bigint AS cost_cents
    FROM "Expense" e
    LEFT JOIN "Purchase" live_purchase
      ON live_purchase."id" = e."purchaseId"
     AND live_purchase."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL
      AND e."lineKind" = 'principal'
      AND (e."purchaseId" IS NULL OR live_purchase."id" IS NOT NULL)
  ), purchase_direction AS (
    SELECT
      "purchaseId",
      coalesce(bool_or(cost_cents > 0), false) AS has_positive,
      coalesce(bool_or(cost_cents < 0), false) AS has_negative
    FROM principal_fact
    WHERE "purchaseId" IS NOT NULL AND cost_cents IS NOT NULL
    GROUP BY "purchaseId"
  ), purchase_coverage AS (
    SELECT
      "purchaseId",
      bool_or(cost_cents IS NULL) AS has_unpriced_principal
    FROM principal_fact
    WHERE "purchaseId" IS NOT NULL
    GROUP BY "purchaseId"
  ), project_weight AS (
    SELECT
      f."purchaseId",
      f."projectId",
      CASE WHEN d.has_positive THEN 'positive' ELSE 'refund' END::text AS basis,
      sum(CASE
        WHEN d.has_positive AND f.cost_cents > 0 THEN f.cost_cents
        WHEN NOT d.has_positive AND d.has_negative AND f.cost_cents < 0 THEN abs(f.cost_cents)
        ELSE 0
      END)::bigint AS weight
    FROM principal_fact f
    JOIN purchase_direction d ON d."purchaseId" = f."purchaseId"
    GROUP BY f."purchaseId", f."projectId", d.has_positive, d.has_negative
    HAVING sum(CASE
      WHEN d.has_positive AND f.cost_cents > 0 THEN f.cost_cents
      WHEN NOT d.has_positive AND d.has_negative AND f.cost_cents < 0 THEN abs(f.cost_cents)
      ELSE 0
    END) > 0
  ), fallback_weight AS (
    SELECT
      p."id" AS "purchaseId",
      default_project."id" AS "projectId",
      'default'::text AS basis,
      1::bigint AS weight
    FROM "Purchase" p
    LEFT JOIN "Project" default_project
      ON default_project."id" = p."defaultProjectId"
     AND default_project."deletedAt" IS NULL
    WHERE p."deletedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM project_weight w WHERE w."purchaseId" = p."id"
      )
  ), weights AS (
    SELECT * FROM project_weight
    UNION ALL
    SELECT * FROM fallback_weight
  ), adjustment_seed AS (
    SELECT
      e."id" AS "expenseId",
      e."purchaseId",
      w."projectId",
      w.basis,
      w.weight,
      round((e."cost")::numeric * 100)::bigint AS source_cents,
      sum(w.weight) OVER (PARTITION BY e."id") AS total_weight,
      coalesce(coverage.has_unpriced_principal, false) AS has_unpriced_principal,
      coalesce(pj."shortcode", '~unassigned') AS allocation_key
    FROM "Expense" e
    JOIN "Purchase" p
      ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
    JOIN weights w ON w."purchaseId" = p."id"
    LEFT JOIN purchase_coverage coverage
      ON coverage."purchaseId" = p."id"
    LEFT JOIN "Project" pj
      ON pj."id" = w."projectId" AND pj."deletedAt" IS NULL
    WHERE e."deletedAt" IS NULL AND e."lineKind" <> 'principal'
  ), adjustment_floor AS (
    SELECT
      *,
      CASE WHEN source_cents IS NULL THEN NULL ELSE
        floor(abs(source_cents)::numeric * weight::numeric / total_weight)::bigint
      END AS base_cents,
      CASE WHEN source_cents IS NULL THEN NULL ELSE
        mod(abs(source_cents)::numeric * weight::numeric, total_weight)
      END AS fractional_rank
    FROM adjustment_seed
  ), adjustment_ranked AS (
    SELECT
      *,
      sum(base_cents) OVER (PARTITION BY "expenseId") AS assigned_cents,
      row_number() OVER (
        PARTITION BY "expenseId"
        ORDER BY fractional_rank DESC NULLS LAST, allocation_key ASC
      ) AS remainder_rank
    FROM adjustment_floor
  ), allocated AS (
    SELECT
      f."expenseId",
      f."purchaseId",
      f."projectId",
      f.cost_cents AS source_cents,
      f.cost_cents AS attributed_cents,
      'principal'::text AS basis,
      f.cost_cents IS NULL AS incomplete
    FROM principal_fact f
    UNION ALL
    SELECT
      r."expenseId",
      r."purchaseId",
      r."projectId",
      r.source_cents,
      CASE WHEN r.source_cents IS NULL THEN NULL ELSE
        sign(r.source_cents) * (
          r.base_cents + CASE
            WHEN r.remainder_rank <= abs(r.source_cents) - r.assigned_cents THEN 1
            ELSE 0
          END
        )
      END::bigint AS attributed_cents,
      r.basis,
      r.basis = 'default' OR r.has_unpriced_principal AS incomplete
    FROM adjustment_ranked r
  )
  SELECT
    a."expenseId",
    a."purchaseId",
    a."projectId",
    p."shortcode" AS "projectShortcode",
    p."name" AS "projectName",
    a.source_cents::text AS "sourceCents",
    a.attributed_cents::text AS "attributedCents",
    a.basis,
    a.incomplete
  FROM allocated a
  LEFT JOIN "Project" p
    ON p."id" = a."projectId" AND p."deletedAt" IS NULL
  ${
    expenseIds
      ? expenseIds.length === 0
        ? sql`WHERE false`
        : sql`WHERE a."expenseId" = ANY(${uuidArrayParam(expenseIds)})`
      : sql``
  }
`;

export type ExpenseAllocationProjectScope = {
  projectIds?: readonly ProjectId[];
  presence?: "has" | "none";
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
  if (projectMatch && presenceMatch) {
    return sql`(${projectMatch} OR ${presenceMatch})`;
  }
  return projectMatch ?? presenceMatch;
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
    SELECT 1 FROM (${expenseProjectAllocationSql()}) allocation
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
    FROM (${expenseProjectAllocationSql()}) allocation
    WHERE allocation."expenseId" = ${expenseId}
      ${scopeCondition ? sql`AND ${scopeCondition}` : sql``}
  )`;
};

export async function loadExpenseProjectAllocations(
  db: Database | DrizzleTransaction,
  expenseIds?: readonly ExpenseId[],
): Promise<ExpenseProjectAllocationRow[]> {
  const result = await unwrapDb(db).execute<RawAllocationRow>(
    expenseProjectAllocationSql(expenseIds),
  );
  return result.rows.map((row) => ({
    ...row,
    sourceCents: row.sourceCents === null ? null : BigInt(row.sourceCents),
    attributedCents:
      row.attributedCents === null ? null : BigInt(row.attributedCents),
  }));
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
