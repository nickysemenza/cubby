import {
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  financialTransactionSourceRefs,
  purchaseSettlementKindAllowedExpression,
  purchaseSettlementSignSatisfiedExpression,
} from "@cubby/schemas/financial-transaction";
import {
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  DuplicateFinancialAccountSourceAlias,
  DuplicateFinancialTransactionSourceRef,
  FinancialTransactionAllocationDefect,
  InvalidFinancialJson,
  PurchaseFinancialSettlementMismatch,
} from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import {
  calculateFinancialReconciliation,
  settleableExpenseTotalSql,
  settleableUnpricedExpenseCountSql,
} from "~/server/repo/financial-reconciliation";
import {
  emptyPurchaseFinancialAggregate,
  loadPurchaseFinancialAggregates,
} from "~/server/repo/purchase-financial-aggregates";

/** Finance JSON is evidence received from imports/MCP; one malformed legacy row
 * must produce a defect, never make the complete Problems scan unavailable. */
export async function findInvalidFinancialJson(
  db: Database,
): Promise<InvalidFinancialJson[]> {
  const result = await getDb(db).execute<{
    entity: "financialAccount" | "financialTransaction";
    id: string;
    identity?: unknown;
    sourceAliases?: unknown;
    sourceRefs?: unknown;
  }>(sql`
    SELECT 'financialAccount' AS entity, fa.shortcode AS id, fa.identity, fa."sourceAliases", NULL AS "sourceRefs"
    FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL
    UNION ALL
    SELECT 'financialTransaction' AS entity, ft.shortcode AS id, NULL AS identity, NULL AS "sourceAliases", ft."sourceRefs"
    FROM "FinancialTransaction" ft WHERE ft."deletedAt" IS NULL
  `);
  const problems: InvalidFinancialJson[] = [];
  for (const row of result.rows) {
    if (row.entity === "financialTransaction") {
      const parsed = financialTransactionSourceRefs.safeParse(row.sourceRefs);
      if (!parsed.success)
        problems.push({
          entity: "financialTransaction",
          id: unsafeFinancialTransactionShortcode(row.id),
          field: "sourceRefs",
          message: parsed.error.issues[0]?.message ?? "Invalid JSON",
        });
      continue;
    }
    const checks = [
      ["identity", financialAccountIdentity.safeParse(row.identity)],
      [
        "sourceAliases",
        financialAccountSourceAliases.safeParse(row.sourceAliases),
      ],
    ] as const;
    for (const [field, parsed] of checks)
      if (!parsed.success)
        problems.push({
          entity: "financialAccount",
          id: unsafeFinancialAccountShortcode(row.id),
          field,
          message: parsed.error.issues[0]?.message ?? "Invalid JSON",
        });
  }
  return problems;
}

export async function findDuplicateFinancialTransactionSourceRefs(
  db: Database,
): Promise<DuplicateFinancialTransactionSourceRef[]> {
  const result = await getDb(db).execute<{
    source: string;
    externalId: string;
    transactionIds: string[];
  }>(sql`
    SELECT r->>'source' AS source, r->>'externalId' AS "externalId", array_agg(ft.shortcode) AS "transactionIds"
    FROM "FinancialTransaction" ft CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ft."sourceRefs") = 'array' THEN ft."sourceRefs" ELSE '[]'::jsonb END) r
    WHERE ft."deletedAt" IS NULL
    GROUP BY r->>'source', r->>'externalId'
    HAVING count(*) > 1
  `);
  return result.rows.map((row) => ({
    ...row,
    transactionIds: row.transactionIds.map(unsafeFinancialTransactionShortcode),
  }));
}

/**
 * The backstop for every `FinancialTransactionAllocation` invariant the write
 * path enforces but the database cannot.
 *
 * `non-settlement-kind` and `kind-sign-violation` are not belt-and-braces: they
 * are now the ONLY enforcement of the settlement kind allowlist and the per-kind
 * sign rule anywhere. `FinancialTransaction_purchase_settlement_check` was
 * dropped with the `purchaseId` column it read, because "is this linked" became
 * a question about another table that a row-level CHECK cannot ask. Both
 * predicates are generated from `purchaseSettlementSignRules` via the shared
 * expression builders, never hand-written, so they cannot drift from the
 * constant the way a hand-mirrored copy would.
 */
export async function findFinancialTransactionAllocationDefects(
  db: Database,
): Promise<FinancialTransactionAllocationDefect[]> {
  const allocationCount = sql`count(a.id)`;
  const allocatedCents = sql`round((sum(a."amount") * 100)::numeric)`;
  const amountCents = sql`round((ft."amount" * 100)::numeric)`;
  const kindAllowed = sql.raw(
    purchaseSettlementKindAllowedExpression("ft.kind"),
  );
  const signSatisfied = sql.raw(
    purchaseSettlementSignSatisfiedExpression({
      kind: "ft.kind",
      amount: `ft."amount"`,
    }),
  );

  // Declared once and reused in both SELECT and HAVING — spelling a predicate
  // twice is the drift this module's own detectors exist to find.
  const sumMismatch = sql`(${allocationCount} > 0 AND ${allocatedCents} IS DISTINCT FROM ${amountCents})`;
  const nonSettlementKind = sql`(${allocationCount} > 0 AND NOT (${kindAllowed}))`;
  const kindSignViolation = sql`(${allocationCount} > 0 AND ${kindAllowed} AND NOT ${signSatisfied})`;
  const allocationSignMismatch = sql`COALESCE(bool_or(sign(a."amount") <> sign(ft."amount")), false)`;

  const result = await getDb(db).execute<{
    id: string;
    kind: string;
    amount: number;
    allocationCount: number;
    allocatedTotal: number;
    purchaseIds: string[] | null;
    sumMismatch: boolean;
    nonSettlementKind: boolean;
    kindSignViolation: boolean;
    allocationSignMismatch: boolean;
  }>(sql`
    SELECT
      ft.shortcode AS id,
      ft.kind AS kind,
      ft."amount" AS amount,
      ${allocationCount}::int AS "allocationCount",
      COALESCE(sum(a."amount"), 0)::double precision AS "allocatedTotal",
      array_remove(array_agg(p.shortcode), NULL) AS "purchaseIds",
      ${sumMismatch} AS "sumMismatch",
      ${nonSettlementKind} AS "nonSettlementKind",
      ${kindSignViolation} AS "kindSignViolation",
      ${allocationSignMismatch} AS "allocationSignMismatch"
    FROM "FinancialTransaction" ft
    LEFT JOIN "FinancialTransactionAllocation" a
      ON a."transactionId" = ft.id AND a."deletedAt" IS NULL
    LEFT JOIN "Purchase" p ON p.id = a."purchaseId"
    WHERE ft."deletedAt" IS NULL
    GROUP BY ft.id
    HAVING ${sumMismatch}
      OR ${nonSettlementKind}
      OR ${kindSignViolation}
      OR ${allocationSignMismatch}
    ORDER BY ft."postedDate" DESC NULLS LAST, ft.shortcode
  `);

  return result.rows.map((row) => ({
    id: unsafeFinancialTransactionShortcode(row.id),
    kind: row.kind,
    amount: Number(row.amount),
    allocationCount: Number(row.allocationCount),
    allocatedTotal: Number(row.allocatedTotal),
    purchaseIds: (row.purchaseIds ?? []).map(unsafePurchaseShortcode),
    reasons: [
      ...(row.sumMismatch ? (["sum-mismatch"] as const) : []),
      ...(row.nonSettlementKind ? (["non-settlement-kind"] as const) : []),
      ...(row.kindSignViolation ? (["kind-sign-violation"] as const) : []),
      ...(row.allocationSignMismatch
        ? (["allocation-sign-mismatch"] as const)
        : []),
    ],
  }));
}

export async function findDuplicateFinancialAccountSourceAliases(
  db: Database,
): Promise<DuplicateFinancialAccountSourceAlias[]> {
  const result = await getDb(db).execute<{
    source: string;
    externalAccountId: string;
    accountIds: string[];
  }>(sql`
    SELECT a->>'source' AS source, a->>'externalAccountId' AS "externalAccountId", array_agg(fa.shortcode) AS "accountIds"
    FROM "FinancialAccount" fa CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fa."sourceAliases") = 'array' THEN fa."sourceAliases" ELSE '[]'::jsonb END) a
    WHERE fa."deletedAt" IS NULL AND a->>'externalAccountId' IS NOT NULL
    GROUP BY a->>'source', a->>'externalAccountId'
    HAVING count(*) > 1
  `);
  return result.rows.map((row) => ({
    ...row,
    accountIds: row.accountIds.map(unsafeFinancialAccountShortcode),
  }));
}

export async function findPurchaseFinancialSettlementMismatches(
  db: Database,
): Promise<PurchaseFinancialSettlementMismatch[]> {
  const result = await getDb(db).execute<{
    uuid: string;
    id: string;
    vendorName: string | null;
    expenseTotal: number;
    settleableExpenseTotal: number;
    settleableUnpriced: number;
  }>(sql`
    SELECT p.id AS uuid, p.shortcode AS id, v.name AS "vendorName",
      COALESCE(e."expenseTotal", 0)::double precision AS "expenseTotal",
      -- The incurred-only rule comes from the shared fragments in
      -- repo/financial-reconciliation, not a third hand-written FILTER. The
      -- reported expenseTotal stays the full figure so the worklist row still
      -- names the purchase's real size; the outer deletedAt predicate below is
      -- this query's half of the fragments' purchase-liveness contract.
      ${sql.raw(settleableExpenseTotalSql("p"))} AS "settleableExpenseTotal",
      ${sql.raw(settleableUnpricedExpenseCountSql("p"))} AS "settleableUnpriced"
    FROM "Purchase" p
    LEFT JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(e.cost), 0) AS "expenseTotal"
      FROM "Expense" e WHERE e."purchaseId" = p.id AND e."deletedAt" IS NULL
    ) e ON TRUE
    WHERE p."deletedAt" IS NULL
  `);
  const purchaseIds = result.rows.map((row) => unsafePurchaseId(row.uuid));
  const financialByPurchase = await loadPurchaseFinancialAggregates(
    db,
    purchaseIds,
  );
  return result.rows.flatMap((row) => {
    const financial =
      financialByPurchase.get(unsafePurchaseId(row.uuid)) ??
      emptyPurchaseFinancialAggregate();
    const financialReconciliation = calculateFinancialReconciliation({
      settleableExpenseTotal: row.settleableExpenseTotal,
      settleableUnpricedExpenseCount: row.settleableUnpriced,
      ...financial,
    });
    if (
      financialReconciliation.status !== "mismatch" ||
      financialReconciliation.delta === null
    )
      return [];
    return [
      {
        id: unsafePurchaseShortcode(row.id),
        vendorName: row.vendorName,
        expenseTotal: Number(row.expenseTotal),
        financialReconciliation: {
          ...financialReconciliation,
          status: "mismatch" as const,
          delta: financialReconciliation.delta,
        },
      },
    ];
  });
}
