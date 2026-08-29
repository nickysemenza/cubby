import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import type {
  ExpenseId,
  LedgerPartyId,
  ProjectId,
} from "@cubby/schemas/identifiers";
import { and, inArray, lte, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
} from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

/**
 * Where a row's party came from. One boolean could not carry this once funder
 * rows became derivable, and a boolean-plus-enum pair would drift.
 */
type AllocationBasis =
  /** An explicit `ExpenseAttribution` row. Always wins for its role. */
  | "recorded"
  /** Funder resolved through the paying account's owner. */
  | "derived_from_payment"
  /** Beneficiary defaulted to the singleton household party. */
  | "assumed_household"
  /** Paid, but every paying account has `ledgerPartyId IS NULL`. */
  | "unowned_account"
  /** No signal at all — the residual seed. */
  | "unknown";

export type ExpenseAllocationRow = {
  expenseId: ExpenseId;
  expenseShortcode: string;
  projectId: ProjectId | null;
  role: "beneficiary" | "funder";
  ledgerPartyId: LedgerPartyId | null;
  /** Public and stable, including `~unattributed` for a null party. */
  allocationKey: string;
  basis: AllocationBasis;
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
 * arithmetic participates in splitting.
 *
 * Four mutually exclusive arms feed `seeded`, and every partition
 * (`expenseId`, `role`) ends up with at least one row so the largest-remainder
 * pass below always reconciles to exactly `abs(cost_cents)`:
 *
 *  A `explicit_attr`      — explicit `ExpenseAttribution` rows. The override.
 *  B `funder_derived`     — funder inferred from the account that paid.
 *  C `beneficiary_assumed`— beneficiary defaulted to the household party.
 *  D `residual_unattributed` — nothing known; the legacy implicit seed.
 *
 * Arms B/C are each guarded by "no explicit row for this role", and arm D is
 * guarded by the exact negation of B and C — built by querying the SAME CTEs
 * they select from rather than restating their conditions. That is deliberate:
 * a restated predicate can drift, and a drifted guard either emits two rows for
 * one role (halving the split) or none (money vanishing from both the party
 * totals and the unattributed bucket, while still counting in `expenseTotal`).
 */
export async function loadExpenseAllocations(
  db: Database | DrizzleTransaction,
  scope: ExpenseAllocationScope,
): Promise<ExpenseAllocationRow[]> {
  if (scope.projectIds?.length === 0) return [];
  const settlementKinds = sql.raw(
    purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", "),
  );
  const result = await unwrapDb(db).execute<RawAllocationRow>(sql`
    WITH scoped_expense AS (
      SELECT
        ${expense.id} AS "expenseId",
        ${expense.shortcode} AS "expenseShortcode",
        ${expense.projectId} AS "projectId",
        ${expense.purchaseId} AS "purchaseId",
        round((${expense.cost})::numeric * 100)::bigint AS cost_cents
      FROM ${expense}
      WHERE ${scopeCondition(scope)}
    ), roles(role) AS (
      VALUES ('beneficiary'::text), ('funder'::text)
    ), explicit_attr AS (
      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        r.role,
        a."ledgerPartyId",
        coalesce(p.shortcode, '~unattributed') AS "allocationKey",
        a.weight::bigint AS weight,
        'recorded'::text AS basis
      FROM scoped_expense e
      CROSS JOIN roles r
      JOIN ${expenseAttribution} a
        ON a."expenseId" = e."expenseId"
       AND a.role = r.role
       AND a."deletedAt" IS NULL
      LEFT JOIN ${ledgerParty} p
        ON p.id = a."ledgerPartyId" AND p."deletedAt" IS NULL

    /* Net signed cents per PAYING PARTY for each expense's linked Purchase.
       Grouping by the owning party rather than the account is what collapses
       two of one party's cards into a single allocationKey — duplicate keys
       would make the remainder tie-break non-deterministic. Every unowned
       account collapses into the one NULL group for the same reason. */
    ), funder_party_net AS (
      SELECT
        e."expenseId",
        fa."ledgerPartyId" AS owner_party_id,
        sum(round(fta.amount::numeric * 100))::bigint AS net_cents
      FROM scoped_expense e
      JOIN ${financialTransactionAllocation} fta
        ON fta."purchaseId" = e."purchaseId" AND fta."deletedAt" IS NULL
      JOIN ${financialTransaction} ft
        ON ft.id = fta."transactionId"
       AND ft."deletedAt" IS NULL
       AND ft.kind IN (${settlementKinds})
       AND ft.status <> 'void'
      JOIN ${financialAccount} fa
        ON fa.id = ft."accountId" AND fa."deletedAt" IS NULL
      GROUP BY e."expenseId", fa."ledgerPartyId"

    /* Only strictly positive nets become weights. Allocation amounts are
       signed (purchase +, refund/income -, adjustment either), so a party whose
       refunds now exceed its charges is not funding anything and drops out
       rather than being clamped to zero. If every party drops out this arm is
       empty and arm D fires — which is also why weight / total_weight can
       never divide by zero: a zero-weight partition has no row to aggregate. */
    ), funder_derived AS (
      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        'funder'::text AS role,
        n.owner_party_id AS "ledgerPartyId",
        coalesce(p.shortcode, '~unowned-account') AS "allocationKey",
        n.net_cents AS weight,
        CASE WHEN n.owner_party_id IS NOT NULL
          THEN 'derived_from_payment' ELSE 'unowned_account' END AS basis
      FROM scoped_expense e
      JOIN funder_party_net n ON n."expenseId" = e."expenseId"
      LEFT JOIN ${ledgerParty} p
        ON p.id = n.owner_party_id AND p."deletedAt" IS NULL
      WHERE n.net_cents > 0
        AND NOT EXISTS (
          SELECT 1 FROM ${expenseAttribution} a
          WHERE a."expenseId" = e."expenseId"
            AND a.role = 'funder'
            AND a."deletedAt" IS NULL
        )

    /* At most one row by LedgerParty_household_singleton_key. The ORDER BY /
       LIMIT is defence against that invariant being violated, not behaviour
       this depends on: without it a second household row would fan the CROSS
       JOIN below and split one expense across two "household" parties. */
    ), household_party AS (
      SELECT id, shortcode
      FROM ${ledgerParty}
      WHERE kind = 'household' AND "deletedAt" IS NULL
      ORDER BY shortcode
      LIMIT 1

    /* The CROSS JOIN is itself the "a household party exists" guard: with an
       empty household_party this arm yields no rows for any expense. */
    ), beneficiary_assumed AS (
      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        'beneficiary'::text AS role,
        h.id AS "ledgerPartyId",
        h.shortcode AS "allocationKey",
        1::bigint AS weight,
        'assumed_household'::text AS basis
      FROM scoped_expense e
      CROSS JOIN household_party h
      WHERE NOT EXISTS (
        SELECT 1 FROM ${expenseAttribution} a
        WHERE a."expenseId" = e."expenseId"
          AND a.role = 'beneficiary'
          AND a."deletedAt" IS NULL
      )

    /* The outer parentheses around the OR are load-bearing. Without them
       AND-before-OR precedence reparses this as
       (no-explicit AND funder-cond) OR beneficiary-cond, dropping the
       no-explicit guard on the beneficiary branch so arms A and D both fire
       and the beneficiary total exceeds cost_cents. Nothing throws. */
    ), residual_unattributed AS (
      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        r.role,
        NULL::uuid AS "ledgerPartyId",
        '~unattributed'::text AS "allocationKey",
        1::bigint AS weight,
        'unknown'::text AS basis
      FROM scoped_expense e
      CROSS JOIN roles r
      WHERE NOT EXISTS (
          SELECT 1 FROM ${expenseAttribution} a
          WHERE a."expenseId" = e."expenseId"
            AND a.role = r.role
            AND a."deletedAt" IS NULL
        )
        AND (
          (r.role = 'funder' AND NOT EXISTS (
            SELECT 1 FROM funder_party_net n
            WHERE n."expenseId" = e."expenseId" AND n.net_cents > 0
          ))
          OR
          (r.role = 'beneficiary' AND NOT EXISTS (
            SELECT 1 FROM household_party
          ))
        )
    ), seeded AS (
      SELECT * FROM explicit_attr
      UNION ALL SELECT * FROM funder_derived
      UNION ALL SELECT * FROM beneficiary_assumed
      UNION ALL SELECT * FROM residual_unattributed
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
      basis,
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
