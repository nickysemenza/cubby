import type {
  ExpenseId,
  LedgerPartyId,
  ProjectId,
} from "@cubby/schemas/identifiers";
import { and, inArray, lte, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { expense, expenseAttribution, ledgerParty } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

export type ExpenseAllocationRow = {
  expenseId: ExpenseId;
  expenseShortcode: string;
  projectId: ProjectId | null;
  role: "beneficiary" | "funder";
  ledgerPartyId: LedgerPartyId | null;
  /** Public and stable, including `~unattributed` for a null party. */
  allocationKey: string;
  implicitUnattributed: boolean;
  cents: bigint;
};

export type ExpenseAllocationScope = {
  asOf?: string;
  projectIds?: readonly ProjectId[];
  includeFuture?: boolean;
};

type RawAllocationRow = Omit<ExpenseAllocationRow, "cents"> & {
  cents: string | number;
};

const scopeCondition = (scope: ExpenseAllocationScope): SQL =>
  and(
    notDeleted(expense),
    scope.asOf ? lte(expense.date, scope.asOf) : undefined,
    scope.includeFuture ? undefined : sql`${expense.future} = false`,
    scope.projectIds
      ? inArray(expense.projectId, [...scope.projectIds])
      : undefined,
    sql`${expense.cost} IS NOT NULL`,
  ) ?? sql`true`;

/**
 * Allocate each scoped Expense independently for both roles in PostgreSQL.
 * Currency is converted to bigint cents before multiplication; no floating
 * arithmetic participates in splitting. An absent role is seeded as one
 * implicit null-target row, so legacy Expenses still reconcile exactly.
 */
export async function loadExpenseAllocations(
  db: Database | DrizzleTransaction,
  scope: ExpenseAllocationScope,
): Promise<ExpenseAllocationRow[]> {
  if (scope.projectIds?.length === 0) return [];
  const result = await unwrapDb(db).execute<RawAllocationRow>(sql`
    WITH scoped_expense AS (
      SELECT
        ${expense.id} AS "expenseId",
        ${expense.shortcode} AS "expenseShortcode",
        ${expense.projectId} AS "projectId",
        round((${expense.cost})::numeric * 100)::bigint AS cost_cents
      FROM ${expense}
      WHERE ${scopeCondition(scope)}
    ), roles(role) AS (
      VALUES ('beneficiary'::text), ('funder'::text)
    ), seeded AS (
      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        r.role,
        a."ledgerPartyId",
        coalesce(p.shortcode, '~unattributed') AS "allocationKey",
        a.weight::bigint AS weight,
        false AS "implicitUnattributed"
      FROM scoped_expense e
      CROSS JOIN roles r
      JOIN ${expenseAttribution} a
        ON a."expenseId" = e."expenseId"
       AND a.role = r.role
       AND a."deletedAt" IS NULL
      LEFT JOIN ${ledgerParty} p
        ON p.id = a."ledgerPartyId" AND p."deletedAt" IS NULL

      UNION ALL

      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        r.role,
        NULL::uuid AS "ledgerPartyId",
        '~unattributed'::text AS "allocationKey",
        1::bigint AS weight,
        true AS "implicitUnattributed"
      FROM scoped_expense e
      CROSS JOIN roles r
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${expenseAttribution} a
        WHERE a."expenseId" = e."expenseId"
          AND a.role = r.role
          AND a."deletedAt" IS NULL
      )
    ), weighted AS (
      SELECT
        seeded.*,
        sum(weight) OVER (PARTITION BY "expenseId", role) AS total_weight
      FROM seeded
    ), based AS (
      SELECT
        weighted.*,
        floor(abs(cost_cents)::numeric * weight / total_weight)::bigint AS base_cents,
        /* Keep this numerator numeric: multiplying a near-bigint cost by an
           int32-max accepted weight can overflow before mod reduces it. */
        mod(
          abs(cost_cents)::numeric * weight::numeric,
          total_weight::numeric
        ) AS fractional_remainder
      FROM weighted
    ), ranked AS (
      SELECT
        based.*,
        sum(base_cents) OVER (PARTITION BY "expenseId", role) AS assigned_cents,
        row_number() OVER (
          PARTITION BY "expenseId", role
          ORDER BY fractional_remainder DESC,
            "allocationKey" ASC
        ) AS remainder_rank
      FROM based
    )
    SELECT
      "expenseId",
      "expenseShortcode",
      "projectId",
      role,
      "ledgerPartyId",
      "allocationKey",
      "implicitUnattributed",
      (
        CASE WHEN cost_cents < 0 THEN -1 ELSE 1 END
        * (base_cents + CASE
            WHEN remainder_rank <= abs(cost_cents) - assigned_cents THEN 1
            ELSE 0
          END)
      )::text AS cents
    FROM ranked
    ORDER BY "expenseId", role, "allocationKey"
  `);
  return result.rows.map((row) => ({ ...row, cents: BigInt(row.cents) }));
}
