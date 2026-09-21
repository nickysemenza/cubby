import {
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  financialTransactionSourceRefs,
  purchaseSettlementKindAllowedExpression,
  purchaseSettlementSignSatisfiedExpression,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  DuplicateFinancialAccountSourceAlias,
  DuplicateFinancialTransactionSourceRef,
  FinancialTransactionAllocationDefect,
  IncompleteStatementImport,
  InvalidFinancialJson,
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
    cardNumbers?: unknown;
    sourceRefs?: unknown;
  }>(sql`
    SELECT 'financialAccount' AS entity, fa.shortcode AS id, fa.identity, fa."sourceAliases", fa."cardNumbers", NULL AS "sourceRefs"
    FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL
    UNION ALL
    SELECT 'financialTransaction' AS entity, ft.shortcode AS id, NULL AS identity, NULL AS "sourceAliases", NULL AS "cardNumbers", ft."sourceRefs"
    FROM "FinancialTransaction" ft WHERE ft."deletedAt" IS NULL
  `);
  const problems: InvalidFinancialJson[] = [];
  for (const row of result.rows) {
    if (row.entity === "financialTransaction") {
      const parsed = financialTransactionSourceRefs.safeParse(row.sourceRefs);
      if (!parsed.success)
        problems.push({
          entity: "financialTransaction",
          id: parseShortcodeFor("financialTransaction", row.id),
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
      ["cardNumbers", financialAccountCardNumbers.safeParse(row.cardNumbers)],
    ] as const;
    for (const [field, parsed] of checks)
      if (!parsed.success)
        problems.push({
          entity: "financialAccount",
          id: parseShortcodeFor("financialAccount", row.id),
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
    transactionIds: row.transactionIds.map((id) =>
      parseShortcodeFor("financialTransaction", id),
    ),
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
type AllocationDefectRow = {
  id: string;
  merchant: string | null;
  rawDescription: string | null;
  postedDate: string | null;
  kind: string;
  amount: number;
  allocationCount: number;
  allocatedTotal: number;
  purchaseIds: string[] | null;
  sumMismatch: boolean;
  nonSettlementKind: boolean;
  kindSignViolation: boolean;
  allocationSignMismatch: boolean;
};

const presentAllocationDefect = (
  row: AllocationDefectRow,
): FinancialTransactionAllocationDefect => ({
  id: parseShortcodeFor("financialTransaction", row.id),
  name: row.merchant ?? row.rawDescription ?? null,
  postedDate: row.postedDate ?? null,
  kind: row.kind,
  amount: Number(row.amount),
  allocationCount: Number(row.allocationCount),
  allocatedTotal: Number(row.allocatedTotal),
  purchaseIds: (row.purchaseIds ?? []).map((id) =>
    parseShortcodeFor("purchase", id),
  ),
  reasons: [
    ...(row.sumMismatch ? (["sum-mismatch"] as const) : []),
    ...(row.nonSettlementKind ? (["non-settlement-kind"] as const) : []),
    ...(row.kindSignViolation ? (["kind-sign-violation"] as const) : []),
    ...(row.allocationSignMismatch
      ? (["allocation-sign-mismatch"] as const)
      : []),
  ],
});

async function queryAllocationDefects(
  db: Database,
  options: { shortcodes?: readonly string[]; defectsOnly: boolean },
): Promise<AllocationDefectRow[]> {
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

  const shortcodeWhere = options.shortcodes
    ? sql` AND ft.shortcode IN (${sql.join(
        options.shortcodes.map((shortcode) => sql`${shortcode}`),
        sql`, `,
      )})`
    : sql``;
  const having = options.defectsOnly
    ? sql`HAVING ${sumMismatch}
      OR ${nonSettlementKind}
      OR ${kindSignViolation}
      OR ${allocationSignMismatch}`
    : sql``;
  const result = await getDb(db).execute<AllocationDefectRow>(sql`
    SELECT
      ft.shortcode AS id,
      ft.merchant AS merchant,
      ft."rawDescription" AS "rawDescription",
      ft."postedDate" AS "postedDate",
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
    WHERE ft."deletedAt" IS NULL${shortcodeWhere}
    GROUP BY ft.id
    ${having}
    ORDER BY ft."postedDate" DESC NULLS LAST, ft.shortcode
  `);
  return result.rows;
}

export async function findFinancialTransactionAllocationDefects(
  db: Database,
): Promise<FinancialTransactionAllocationDefect[]> {
  return (await queryAllocationDefects(db, { defectsOnly: true })).map(
    presentAllocationDefect,
  );
}

/**
 * Presentation hydration for the canonical transaction page. Unlike the
 * detector this accepts the already-selected shortcodes and deliberately has
 * no HAVING membership test.
 */
export async function loadAllocationDefectPresenters(
  db: Database,
  shortcodes: readonly string[],
): Promise<Map<string, FinancialTransactionAllocationDefect>> {
  if (shortcodes.length === 0) return new Map();
  const rows = await queryAllocationDefects(db, {
    shortcodes,
    defectsOnly: false,
  });
  return new Map(rows.map((row) => [row.id, presentAllocationDefect(row)]));
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
    accountIds: row.accountIds.map((id) =>
      parseShortcodeFor("financialAccount", id),
    ),
  }));
}

/**
 * Provider exports whose stored rows fall short of what the client declared —
 * a chunked ingest that stopped partway, which otherwise looks exactly like a
 * complete import that happened to be short.
 *
 * Deliberately the only statement-ledger detector: unmatched rows are the drift
 * worklist, not defects, and 15k of them here would make Problems unusable.
 */
export async function findIncompleteStatementImports(
  db: Database,
): Promise<IncompleteStatementImport[]> {
  const result = await getDb(db).execute<{
    source: string;
    label: string;
    fingerprint: string;
    rowCountDeclared: number;
    rowCountStored: number;
  }>(sql`
    SELECT si.source, si.label, si.fingerprint,
           si."rowCountDeclared" AS "rowCountDeclared",
           count(sr.id)::int AS "rowCountStored"
    FROM "StatementImport" si
    LEFT JOIN "StatementRow" sr
      ON sr."batchId" = si.id AND sr."deletedAt" IS NULL
    WHERE si."deletedAt" IS NULL AND si."rowCountDeclared" IS NOT NULL
    GROUP BY si.id, si.source, si.label, si.fingerprint, si."rowCountDeclared"
    HAVING count(sr.id) < si."rowCountDeclared"
  `);
  return result.rows.map((row) => ({
    source: row.source,
    label: row.label,
    fingerprint: row.fingerprint,
    rowCountDeclared: Number(row.rowCountDeclared),
    rowCountStored: Number(row.rowCountStored),
  }));
}
