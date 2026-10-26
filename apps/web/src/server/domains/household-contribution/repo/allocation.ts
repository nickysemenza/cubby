import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import { financialTransactionStatus } from "@cubby/schemas/financial-transaction-fields";
import type {
  ExpenseId,
  LedgerPartyId,
  ProjectId,
} from "@cubby/schemas/identifiers";
import { contributionRole, ledgerPartyKind } from "@cubby/schemas/ledger-party";
import { and, lte, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
  purchase,
} from "~/server/db/schema";
import { expenseDerivedCostsSql } from "~/server/domains/expense/repo/expense-derived-read";
import { effectiveExpenseProjectSql } from "~/server/domains/expense/repo/expense-inheritance";
import { paymentFundingPartySql } from "~/server/domains/financial-account/repo/funding-sql";
import { purchasePurchaserSql } from "~/server/domains/purchase/repo/purchase-purchaser";

/**
 * Where a row's party came from. One boolean could not carry this once funder
 * rows became derivable, and a boolean-plus-enum pair would drift.
 */
type AllocationBasis =
  /** An explicit `ExpenseAttribution` row. Always wins for its role. */
  | "recorded"
  /** Funder from dated funding evidence, or beneficiary from account ownership. */
  | "derived_from_payment"
  /** Beneficiary inherited from the Purchase's effective purchaser. */
  | "derived_from_purchaser"
  /** Beneficiary defaulted to the singleton household party. */
  | "assumed_household"
  /** Paid from an account with no funding party known for that payment. */
  | "unowned_account"
  /** Funder of a future expense: not due yet, so nobody has paid it. */
  | "not_yet_paid"
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
  expenseIds?: readonly ExpenseId[];
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
    scope.expenseIds
      ? sql`${expense.id} = ANY(${uuidArrayParam(scope.expenseIds)})`
      : undefined,
    scope.asOf ? lte(expense.date, scope.asOf) : undefined,
    scope.includeFuture ? undefined : actualExpense(),
    sql`${expense.cost} IS NOT NULL`,
  ) ?? sql`true`;

/**
 * Allocate each scoped Expense independently for both roles in PostgreSQL.
 * Currency is converted to bigint cents before multiplication; no floating
 * arithmetic participates in splitting.
 *
 * Mutually exclusive sources feed `seeded`, and every partition
 * (`expenseId`, `role`) ends up with at least one row so the largest-remainder
 * pass below always reconciles to exactly `abs(cost_cents)`:
 *
 *  A `explicit_attr`      — explicit `ExpenseAttribution` rows. The override.
 *  B `funder_derived`     — funder inferred from the account that paid.
 *  C beneficiary defaults — paying account ownership, then the effective
 *    purchaser, then the household party. Explicit funders do not decide these.
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
  if (scope.expenseIds?.length === 0) return [];
  const accountOwner = alias(ledgerParty, "account_owner");
  const nullableParty = alias(ledgerParty, "p");
  const purchaserParty = alias(ledgerParty, "purchaser_party");
  const settlementKinds = sql.raw(
    purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", "),
  );
  const result = await unwrapDb(db).execute<RawAllocationRow>(sql`
    WITH scoped_expense AS (
      SELECT
        ${expense.id} AS "expenseId",
        ${expense.shortcode} AS "expenseShortcode",
        ${scope.projectIds ? sql`derived_cost."projectId"` : effectiveExpenseProjectSql()} AS "projectId",
        ${expense.purchaseId} AS "purchaseId",
        ${expense.future} AS future,
        ${scope.projectIds ? sql`derived_cost."costCents"` : sql`round((${expense.cost})::numeric * 100)::bigint`} AS cost_cents
      FROM ${expense}
      ${scope.projectIds ? sql`JOIN (${expenseDerivedCostsSql({ projectIds: scope.projectIds }, scope.expenseIds)}) derived_cost ON derived_cost."expenseId" = ${expense.id}` : sql``}
      WHERE ${scopeCondition(scope)}
    ), roles(role) AS (
      VALUES (${contributionRole.enum.beneficiary}::text), (${contributionRole.enum.funder}::text)
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
        ON p.id = a."ledgerPartyId" AND ${notDeleted(nullableParty)}

    /* Outgoing and incoming cents per PAYING PARTY for each expense's linked
       Purchase. Grouping by the owning party rather than the account is what
       collapses two of one party's cards into a single allocationKey —
       duplicate keys would make the remainder tie-break non-deterministic.
       Every unowned account collapses into the one NULL group for the same
       reason. */
    ), payment_party_flow AS (
      SELECT
        e."expenseId",
        party_source.role,
        party_source.owner_party_id,
        coalesce(sum(round(fta.amount::numeric * 100))
          FILTER (WHERE fta.amount > 0), 0)::bigint AS gross_cents,
        coalesce(sum(round(-fta.amount::numeric * 100))
          FILTER (WHERE fta.amount < 0), 0)::bigint AS inflow_cents
      FROM scoped_expense e
      JOIN ${financialTransactionAllocation} fta
        ON fta."purchaseId" = e."purchaseId" AND fta."deletedAt" IS NULL
      JOIN ${financialTransaction} ft
        ON ft.id = fta."transactionId"
       AND ft."deletedAt" IS NULL
       AND ft.kind IN (${settlementKinds})
       AND ft.status <> ${financialTransactionStatus.enum.void}
      JOIN ${financialAccount} fa
        ON fa.id = ft."accountId" AND fa."deletedAt" IS NULL
      LEFT JOIN ${ledgerParty} account_owner
        ON account_owner.id = fa."ledgerPartyId" AND ${notDeleted(accountOwner)}
      CROSS JOIN LATERAL (VALUES
        (${contributionRole.enum.funder}::text, ${paymentFundingPartySql(sql`fa`, sql`ft`)}),
        (${contributionRole.enum.beneficiary}::text, account_owner.id)
      ) party_source(role, owner_party_id)
      GROUP BY e."expenseId", party_source.role, party_source.owner_party_id

    /* Weight by GROSS outlay — the sum of positive allocations — not by the net.
       Allocation amounts are signed (purchase +, refund/income -, adjustment
       either), and netting would charge a refund twice: once by shrinking the
       weight here, and again as the negative-cost Expense that already receives
       a negative share. initiallyOutlaid means money INITIALLY put in, which is
       gross. Netting also dropped a fully-refunded order entirely (net 0, no
       party), so every one of its expenses reported missing_funders — 155 of
       them, recovering to within $0.47 of the same total once weighted gross.

       A Purchase with no outgoing settlement at all (a guest's settle-up
       repayment received into a member's wallet) has no outlay to weight, so
       it weights by money received instead: the receiving party is whose
       position the negative Expense changes. Only that whole-purchase case
       switches basis; a mixed purchase keeps gross outlay.

       A party with zero weight contributes nothing, so if every party drops
       out this arm is empty and arm D fires. That is also why
       weight / total_weight can never divide by zero: a zero-weight partition
       has no row to aggregate over. */
    ), payment_weight AS (
      SELECT
        f."expenseId",
        f.role,
        f.owner_party_id,
        CASE WHEN bool_or(f.gross_cents > 0) OVER (PARTITION BY f."expenseId", f.role)
          THEN f.gross_cents ELSE f.inflow_cents END AS weight_cents
      FROM payment_party_flow f
    ), funder_weight AS (
      SELECT "expenseId", owner_party_id, weight_cents FROM payment_weight WHERE role = ${contributionRole.enum.funder}
    ), funder_derived AS (
      SELECT
        e."expenseId",
        e."expenseShortcode",
        e."projectId",
        e.cost_cents,
        ${contributionRole.enum.funder}::text AS role,
        n.owner_party_id AS "ledgerPartyId",
        coalesce(p.shortcode, '~unowned-account') AS "allocationKey",
        n.weight_cents AS weight,
        CASE WHEN n.owner_party_id IS NOT NULL
          THEN 'derived_from_payment' ELSE 'unowned_account' END AS basis
      FROM scoped_expense e
      JOIN funder_weight n ON n."expenseId" = e."expenseId"
      LEFT JOIN ${ledgerParty} p
        ON p.id = n.owner_party_id AND ${notDeleted(nullableParty)}
      WHERE n.weight_cents > 0
        AND NOT EXISTS (
          SELECT 1 FROM ${expenseAttribution} a
          WHERE a."expenseId" = e."expenseId"
            AND a.role = ${contributionRole.enum.funder}
            AND a."deletedAt" IS NULL
        )

    ), beneficiary_payment AS (
      SELECT e."expenseId", e."expenseShortcode", e."projectId", e.cost_cents,
        ${contributionRole.enum.beneficiary}::text AS role, n.owner_party_id AS "ledgerPartyId",
        coalesce(p.shortcode, '~unattributed') AS "allocationKey",
        n.weight_cents AS weight,
        CASE WHEN p.id IS NOT NULL THEN 'derived_from_payment' ELSE 'unknown' END AS basis
      FROM scoped_expense e
      JOIN payment_weight n ON n."expenseId" = e."expenseId" AND n.role = ${contributionRole.enum.beneficiary}
      LEFT JOIN ${ledgerParty} p ON p.id = n.owner_party_id AND ${notDeleted(nullableParty)}
      WHERE n.weight_cents > 0
        AND NOT EXISTS (SELECT 1 FROM explicit_attr a WHERE a."expenseId" = e."expenseId" AND a.role = ${contributionRole.enum.beneficiary})
        -- Partial payment ownership retains its unknown share. Entirely
        -- unknown payment ownership can use the purchaser/household fallback.
        AND EXISTS (SELECT 1 FROM payment_weight known
          JOIN ${ledgerParty} owner ON owner.id = known.owner_party_id AND owner."deletedAt" IS NULL
          WHERE known."expenseId" = e."expenseId" AND known.role = ${contributionRole.enum.beneficiary} AND known.weight_cents > 0)
    ), beneficiary_purchaser AS (
      SELECT e."expenseId", e."expenseShortcode", e."projectId", e.cost_cents,
        ${contributionRole.enum.beneficiary}::text AS role, purchaser_party.id AS "ledgerPartyId",
        purchaser_party.shortcode AS "allocationKey", 1::bigint AS weight,
        'derived_from_purchaser'::text AS basis
      FROM scoped_expense e
      JOIN ${purchase} ON ${purchase.id} = e."purchaseId" AND ${notDeleted(purchase)}
      JOIN ${ledgerParty} purchaser_party
        ON purchaser_party.shortcode = ${purchasePurchaserSql} AND ${notDeleted(purchaserParty)}
      WHERE NOT EXISTS (SELECT 1 FROM explicit_attr a WHERE a."expenseId" = e."expenseId" AND a.role = ${contributionRole.enum.beneficiary})
        AND NOT EXISTS (SELECT 1 FROM beneficiary_payment b WHERE b."expenseId" = e."expenseId")

    /* At most one row by LedgerParty_household_singleton_key. The ORDER BY /
       LIMIT is defence against that invariant being violated, not behaviour
       this depends on: without it a second household row would fan the CROSS
       JOIN below and split one expense across two "household" parties. */
    ), household_party AS (
      SELECT id, shortcode
      FROM ${ledgerParty}
      WHERE kind = ${ledgerPartyKind.enum.household} AND "deletedAt" IS NULL
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
        ${contributionRole.enum.beneficiary}::text AS role,
        h.id AS "ledgerPartyId",
        h.shortcode AS "allocationKey",
        1::bigint AS weight,
        'assumed_household'::text AS basis
      FROM scoped_expense e
      CROSS JOIN household_party h
      WHERE NOT EXISTS (
        SELECT 1 FROM ${expenseAttribution} a
        WHERE a."expenseId" = e."expenseId"
          AND a.role = ${contributionRole.enum.beneficiary}
          AND a."deletedAt" IS NULL
      )
        AND NOT EXISTS (SELECT 1 FROM beneficiary_payment b WHERE b."expenseId" = e."expenseId")
        AND NOT EXISTS (SELECT 1 FROM beneficiary_purchaser b WHERE b."expenseId" = e."expenseId")

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
        /* A future expense's funder is not missing, it is not due yet — the
           money has not moved. Distinguishing it here rather than gating arm B
           on future is deliberate: some future rows DO have settlement (an
           instalment on an order already part-paid), and gating derivation
           would strip their real funders. The row is still emitted so the
           partition stays non-empty and
           fundedTotal + unattributedFunding = expenseTotal keeps holding. */
        CASE WHEN r.role = ${contributionRole.enum.funder} AND e.future
          THEN 'not_yet_paid' ELSE 'unknown' END AS basis
      FROM scoped_expense e
      CROSS JOIN roles r
      WHERE NOT EXISTS (
          SELECT 1 FROM ${expenseAttribution} a
          WHERE a."expenseId" = e."expenseId"
            AND a.role = r.role
            AND a."deletedAt" IS NULL
        )
        AND (
          (r.role = ${contributionRole.enum.funder} AND NOT EXISTS (
            SELECT 1 FROM funder_weight n
            WHERE n."expenseId" = e."expenseId" AND n.weight_cents > 0
          ))
          OR
          (r.role = ${contributionRole.enum.beneficiary} AND NOT EXISTS (
            SELECT 1 FROM household_party
          ) AND NOT EXISTS (SELECT 1 FROM beneficiary_payment b WHERE b."expenseId" = e."expenseId")
            AND NOT EXISTS (SELECT 1 FROM beneficiary_purchaser b WHERE b."expenseId" = e."expenseId"))
        )
    ), seeded AS (
      SELECT * FROM explicit_attr
      UNION ALL SELECT * FROM funder_derived
      UNION ALL SELECT * FROM beneficiary_payment
      UNION ALL SELECT * FROM beneficiary_purchaser
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
