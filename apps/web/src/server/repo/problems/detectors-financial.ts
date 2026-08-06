import {
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import { financialTransactionSourceRefs } from "@cubby/schemas/financial-transaction";
import {
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  DuplicateFinancialAccountSourceAlias,
  DuplicateFinancialTransactionSourceRef,
  InvalidFinancialJson,
  PurchaseFinancialSettlementMismatch,
} from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import { calculateFinancialReconciliation } from "~/server/repo/financial-reconciliation";
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
      COALESCE(e."settleableExpenseTotal", 0)::double precision AS "settleableExpenseTotal",
      COALESCE(e."settleableUnpriced", 0)::int AS "settleableUnpriced"
    FROM "Purchase" p
    LEFT JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(e.cost), 0) AS "expenseTotal",
        -- Settlement compares against INCURRED spend; a planned row cannot have
        -- settled, so counting it guarantees a mismatch. The reported
        -- expenseTotal stays the full figure so the worklist row still names
        -- the purchase's real size.
        COALESCE(sum(e.cost) FILTER (WHERE e.future = false), 0) AS "settleableExpenseTotal",
        count(e.id) FILTER (WHERE e.cost IS NULL AND e.future = false) AS "settleableUnpriced"
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
