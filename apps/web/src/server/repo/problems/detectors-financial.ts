import {
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import { financialTransactionSourceRefs } from "@cubby/schemas/financial-transaction";
import {
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
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
    id: string;
    vendorName: string | null;
    expenseTotal: number;
    unpriced: number;
    transactionCount: number;
    postedTransactionCount: number;
    outstandingTransactionCount: number;
    postedTotal: number;
    projectedTotal: number;
  }>(sql`
    SELECT p.shortcode AS id, v.name AS "vendorName", COALESCE(e."expenseTotal", 0)::double precision AS "expenseTotal",
      COALESCE(e.unpriced, 0)::int AS unpriced,
      COALESCE(ft."transactionCount", 0)::int AS "transactionCount",
      COALESCE(ft."postedTransactionCount", 0)::int AS "postedTransactionCount",
      COALESCE(ft."outstandingTransactionCount", 0)::int AS "outstandingTransactionCount",
      COALESCE(ft."postedTotal", 0)::double precision AS "postedTotal",
      COALESCE(ft."projectedTotal", 0)::double precision AS "projectedTotal"
    FROM "Purchase" p
    LEFT JOIN "Vendor" v ON v.id = p."vendorId" AND v."deletedAt" IS NULL
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(e.cost), 0) AS "expenseTotal", count(e.id) FILTER (WHERE e.cost IS NULL) AS unpriced
      FROM "Expense" e WHERE e."purchaseId" = p.id AND e."deletedAt" IS NULL
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(ft.id) AS "transactionCount", count(ft.id) FILTER (WHERE ft.status = 'posted') AS "postedTransactionCount",
        count(ft.id) FILTER (WHERE ft.status IN ('expected', 'pending')) AS "outstandingTransactionCount",
        COALESCE(sum(ft.amount) FILTER (WHERE ft.status = 'posted'), 0) AS "postedTotal", COALESCE(sum(ft.amount), 0) AS "projectedTotal"
      FROM "FinancialTransaction" ft WHERE ft."purchaseId" = p.id AND ft."deletedAt" IS NULL AND ft.status <> 'void'
    ) ft ON TRUE
    WHERE p."deletedAt" IS NULL
  `);
  const cents = (n: number) => Math.round(Number(n) * 100);
  return result.rows.flatMap((row) => {
    const outstanding = Number(row.outstandingTransactionCount);
    const comparable =
      Number(row.unpriced) === 0 && Number(row.transactionCount) > 0;
    const total =
      outstanding > 0 ? Number(row.projectedTotal) : Number(row.postedTotal);
    if (!comparable || cents(total) === cents(Number(row.expenseTotal)))
      return [];
    return [
      {
        id: unsafePurchaseShortcode(row.id),
        vendorName: row.vendorName,
        expenseTotal: Number(row.expenseTotal),
        financialReconciliation: {
          status: "mismatch" as const,
          transactionCount: Number(row.transactionCount),
          postedTransactionCount: Number(row.postedTransactionCount),
          outstandingTransactionCount: outstanding,
          postedTotal: Number(row.postedTotal),
          projectedTotal: Number(row.projectedTotal),
          delta: total - Number(row.expenseTotal),
        },
      },
    ];
  });
}
