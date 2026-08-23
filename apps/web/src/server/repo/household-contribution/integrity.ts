import type { FinancialTransactionId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { unwrapDb } from "~/server/repo/database-helpers";

export type HouseholdContributionDefect = {
  code:
    | "person_funding_source_count"
    | "funding_source_shape"
    | "attribution_target_missing"
    | "expense_source_orphaned"
    | "transfer_party_missing"
    | "transfer_evidence_invalid";
  targetId: string;
  detail: string;
};

type DefectRow = HouseholdContributionDefect;

/**
 * Post-write auditor for invariants that span soft-deleted rows or several
 * tables and therefore cannot be expressed by a row CHECK/FK alone.
 */
export async function findHouseholdContributionDefects(
  db: Database | DrizzleTransaction,
): Promise<HouseholdContributionDefect[]> {
  const result = await unwrapDb(db).execute<DefectRow>(sql`
    WITH defects AS (
      SELECT
        'person_funding_source_count'::text AS code,
        p.shortcode::text AS "targetId",
        ('expected one live person funding source; found ' || count(fs.id))::text AS detail
      FROM "Person" p
      LEFT JOIN "FundingSource" fs
        ON fs."personId" = p.id AND fs."deletedAt" IS NULL
      WHERE p."deletedAt" IS NULL
      GROUP BY p.id
      HAVING count(fs.id) <> 1

      UNION ALL

      SELECT
        'funding_source_shape',
        fs.id::text,
        'live person funding source points to a missing or deleted Person'
      FROM "FundingSource" fs
      LEFT JOIN "Person" p ON p.id = fs."personId" AND p."deletedAt" IS NULL
      WHERE fs."deletedAt" IS NULL AND fs.kind = 'person' AND p.id IS NULL

      UNION ALL

      SELECT
        'attribution_target_missing',
        a.id::text,
        'live attribution points to a missing or deleted target'
      FROM "ExpenseAttribution" a
      LEFT JOIN "Expense" e ON e.id = a."expenseId" AND e."deletedAt" IS NULL
      LEFT JOIN "Person" p ON p.id = a."personId" AND p."deletedAt" IS NULL
      LEFT JOIN "FundingSource" fs
        ON fs.id = a."fundingSourceId" AND fs."deletedAt" IS NULL
      WHERE a."deletedAt" IS NULL AND (
        e.id IS NULL
        OR (a."personId" IS NOT NULL AND p.id IS NULL)
        OR (a."fundingSourceId" IS NOT NULL AND fs.id IS NULL)
      )

      UNION ALL

      SELECT
        'expense_source_orphaned',
        r.id::text,
        'live Expense source reference belongs to a missing or deleted Expense'
      FROM "ExpenseSourceRef" r
      LEFT JOIN "Expense" e ON e.id = r."expenseId" AND e."deletedAt" IS NULL
      WHERE r."deletedAt" IS NULL AND e.id IS NULL

      UNION ALL

      SELECT
        'transfer_party_missing',
        t.id::text,
        'live transfer points to a missing or deleted funding source'
      FROM "FundingTransfer" t
      LEFT JOIN "FundingSource" f1
        ON f1.id = t."fromSourceId" AND f1."deletedAt" IS NULL
      LEFT JOIN "FundingSource" f2
        ON f2.id = t."toSourceId" AND f2."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL AND (f1.id IS NULL OR f2.id IS NULL)

      UNION ALL

      SELECT
        'transfer_evidence_invalid',
        ev.id::text,
        'live transfer evidence is orphaned, unposted, wrong-sign, wrong-amount, or mapped to the wrong party'
      FROM "FundingTransferEvidence" ev
      LEFT JOIN "FundingTransfer" t
        ON t.id = ev."transferId" AND t."deletedAt" IS NULL
      LEFT JOIN "FinancialTransaction" ft
        ON ft.id = ev."transactionId" AND ft."deletedAt" IS NULL
      LEFT JOIN "FinancialAccount" fa
        ON fa.id = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE ev."deletedAt" IS NULL AND (
        t.id IS NULL OR ft.id IS NULL OR fa.id IS NULL
        OR ft.status <> 'posted'
        OR round(abs(ft.amount)::numeric * 100) <> round(t.amount::numeric * 100)
        OR (ev.side = 'outflow' AND (ft.amount <= 0 OR fa."fundingSourceId" IS DISTINCT FROM t."fromSourceId"))
        OR (ev.side = 'inflow' AND (ft.amount >= 0 OR fa."fundingSourceId" IS DISTINCT FROM t."toSourceId"))
      )

      UNION ALL

      SELECT
        'transfer_evidence_invalid',
        t.id::text,
        'two-sided live transfer evidence must use two distinct financial accounts'
      FROM "FundingTransfer" t
      JOIN "FundingTransferEvidence" ev
        ON ev."transferId" = t.id AND ev."deletedAt" IS NULL
      JOIN "FinancialTransaction" ft
        ON ft.id = ev."transactionId" AND ft."deletedAt" IS NULL
      JOIN "FinancialAccount" fa
        ON fa.id = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL
      GROUP BY t.id
      HAVING count(ev.id) = 2 AND count(DISTINCT fa.id) <> 2
    )
    SELECT code, "targetId", detail FROM defects ORDER BY code, "targetId"
  `);
  return result.rows;
}

export async function assertHouseholdContributionIntegrity(
  db: Database | DrizzleTransaction,
): Promise<void> {
  const defects = await findHouseholdContributionDefects(db);
  if (defects.length === 0) return;
  throw createAppError(
    "HOUSEHOLD_LEDGER_INVALID_ATTRIBUTION",
    `Household contribution integrity check found ${defects.length} defect(s): ${defects
      .slice(0, 5)
      .map((row) => `${row.code}:${row.targetId}`)
      .join(", ")}`,
  );
}

/**
 * Mutation guard for FinancialTransaction/account edits. Evidence is allowed to
 * be absent or one-sided, but every live leg that exists must remain posted,
 * whole-amount, correctly signed, and mapped to its transfer endpoint.
 */
export async function assertFinancialTransactionFundingEvidenceValid(
  db: Database | DrizzleTransaction,
  transactionId: FinancialTransactionId,
): Promise<void> {
  const result = await unwrapDb(db).execute<{ id: string }>(sql`
    WITH affected_transfer AS (
      SELECT DISTINCT ev."transferId"
      FROM "FundingTransferEvidence" ev
      WHERE ev."deletedAt" IS NULL
        AND ev."transactionId" = ${transactionId}
    ), invalid_leg AS (
      SELECT ev.id::text AS id
      FROM "FundingTransferEvidence" ev
      JOIN affected_transfer affected ON affected."transferId" = ev."transferId"
      LEFT JOIN "FundingTransfer" t ON t.id = ev."transferId"
      LEFT JOIN "FinancialTransaction" ft ON ft.id = ev."transactionId"
      LEFT JOIN "FinancialAccount" fa ON fa.id = ft."accountId"
      WHERE ev."deletedAt" IS NULL
        AND (
          t.id IS NULL OR t."deletedAt" IS NOT NULL
          OR ft.id IS NULL OR ft."deletedAt" IS NOT NULL
          OR fa.id IS NULL OR fa."deletedAt" IS NOT NULL
          OR ft.status <> 'posted'
          OR round(abs(ft.amount)::numeric * 100) <> round(t.amount::numeric * 100)
          OR (ev.side = 'outflow' AND (ft.amount <= 0 OR fa."fundingSourceId" IS DISTINCT FROM t."fromSourceId"))
          OR (ev.side = 'inflow' AND (ft.amount >= 0 OR fa."fundingSourceId" IS DISTINCT FROM t."toSourceId"))
        )
    ), collapsed_accounts AS (
      SELECT min(ev.id::text) AS id
      FROM "FundingTransferEvidence" ev
      JOIN affected_transfer affected ON affected."transferId" = ev."transferId"
      JOIN "FinancialTransaction" ft
        ON ft.id = ev."transactionId" AND ft."deletedAt" IS NULL
      JOIN "FinancialAccount" fa
        ON fa.id = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE ev."deletedAt" IS NULL
      GROUP BY ev."transferId"
      HAVING count(ev.id) = 2 AND count(DISTINCT fa.id) <> 2
    )
    SELECT id FROM invalid_leg
    UNION ALL
    SELECT id FROM collapsed_accounts
    LIMIT 1
  `);
  if (!result.rows[0]) return;
  throw createAppError(
    "HOUSEHOLD_LEDGER_INVALID_TRANSFER",
    "Financial transaction mutation would invalidate funding-transfer evidence",
  );
}
