import {
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "@cubby/schemas/financial-account";
import {
  purchaseSettlementKindAllowedExpression,
  purchaseSettlementSignSatisfiedExpression,
} from "@cubby/schemas/financial-transaction";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { ProblemItem } from "@cubby/schemas/problems-raw-read";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { getDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { transactionImportRecord } from "~/server/db/retained-tables";
import { allocationIntegrityDefectSql } from "~/server/domains/financial-transaction/repo/financial-allocation-integrity";

/** Finance JSON is evidence received from imports/MCP; one malformed legacy row
 * must produce a defect, never make the complete Problems scan unavailable. */
export async function findInvalidFinancialJson(
  db: Database,
): Promise<ProblemItem<"invalidFinancialJson">[]> {
  const result = await getDb(db).execute<{
    entity: "financialAccount" | "financialTransaction";
    id: string;
    identity?: unknown;
    sourceAliases?: unknown;
    cardNumbers?: unknown;
  }>(sql`
    SELECT ${"financialAccount"}::text AS entity, fa.shortcode AS id, fa.identity, fa."sourceAliases", fa."cardNumbers"
    FROM "FinancialAccount" fa WHERE ${notDeleted("fa")}
  `);
  // Settlement references are EntityExternalId rows now; only the account's
  // JSON columns can hold malformed JSON.
  const problems: ProblemItem<"invalidFinancialJson">[] = [];
  for (const row of result.rows) {
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
): Promise<ProblemItem<"duplicateFinancialTransactionSourceRefs">[]> {
  const rows = await getDb(db).execute<{
    source: string;
    value: string;
    transactions: string[];
  }>(
    sql`
    SELECT alias.source,alias.value,array_agg(DISTINCT target.shortcode ORDER BY target.shortcode) AS transactions
    FROM "FinancialEvidenceAlias" alias
    JOIN "FinancialTransaction" target ON target.id=alias."historicalTransactionId" AND ${notDeleted("target")}
    WHERE alias.kind='transaction_ref' AND ${notDeleted("alias")}
      -- includes-deleted: retained source aliases remain evidence rather than non-occurrence ownership.
      AND NOT EXISTS(SELECT 1 FROM "FinancialEvidenceAlias" observation WHERE observation.source=alias.source AND observation.value=alias.value AND observation."observationId" IS NOT NULL)
    GROUP BY alias.source,alias.value HAVING count(DISTINCT target.id)>1
    ORDER BY alias.source,alias.value`,
    "objects",
  );
  return rows.map((row) => ({
    source: row.source,
    externalId: row.value,
    transactionIds: row.transactions.map((id) =>
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
): ProblemItem<"financialTransactionAllocationDefects"> => ({
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
  const allocatedCents = sql`sum(a."amountMinor")`;
  const amountCents = sql`ft."amountMinor"`;
  const kindAllowed = sql.raw(
    purchaseSettlementKindAllowedExpression("ft.kind"),
  );
  const signSatisfied = sql.raw(
    purchaseSettlementSignSatisfiedExpression({
      kind: "ft.kind",
      amount: `(ft."amountMinor"::numeric / 100)`,
    }),
  );

  // Declared once and reused in both SELECT and HAVING — spelling a predicate
  // twice is the drift this module's own detectors exist to find.
  const sumMismatch = sql`(${allocationCount} > 0 AND ${allocatedCents} IS DISTINCT FROM ${amountCents})`;
  const nonSettlementKind = sql`(${allocationCount} > 0 AND NOT (${kindAllowed}))`;
  const kindSignViolation = sql`(${allocationCount} > 0 AND ${kindAllowed} AND NOT ${signSatisfied})`;
  const allocationSignMismatch = sql`COALESCE(bool_or(sign(a."amountMinor") <> sign(ft."amountMinor")), false)`;

  const shortcodeWhere = options.shortcodes
    ? sql` AND ft.shortcode IN (${sql.join(
        options.shortcodes.map((shortcode) => sql`${shortcode}`),
        sql`, `,
      )})`
    : sql``;
  // Live, not the published check: a raw allocation edit must surface without a refresh.
  const diagnosticWhere = options.defectsOnly
    ? sql` AND ${allocationIntegrityDefectSql("ft")}`
    : sql``;
  const result = await getDb(db).execute<AllocationDefectRow>(sql`
    SELECT
      ft.shortcode AS id,
      ft.merchant AS merchant,
      ft."rawDescription" AS "rawDescription",
      ft."postedDate" AS "postedDate",
      ft.kind AS kind,
      (${minorToDollarsSql(sql`ft."amountMinor"`, "numeric")})::float8 AS amount,
      ${allocationCount}::int AS "allocationCount",
      COALESCE(sum((${minorToDollarsSql(sql`a."amountMinor"`, "numeric")})), 0)::double precision AS "allocatedTotal",
      array_remove(array_agg(p.shortcode), NULL) AS "purchaseIds",
      ${sumMismatch} AS "sumMismatch",
      ${nonSettlementKind} AS "nonSettlementKind",
      ${kindSignViolation} AS "kindSignViolation",
      ${allocationSignMismatch} AS "allocationSignMismatch"
    FROM "FinancialTransaction" ft
    LEFT JOIN "FinancialTransactionAllocation" a
      ON a."transactionId" = ft.id AND ${notDeleted("a")}
    LEFT JOIN "Purchase" p ON p.id = a."purchaseId"
    WHERE ${notDeleted("ft")}${shortcodeWhere}${diagnosticWhere}
    GROUP BY ft.id
    ORDER BY ft."postedDate" DESC NULLS LAST, ft.shortcode
  `);
  return result.rows;
}

export async function findFinancialTransactionAllocationDefects(
  db: Database,
): Promise<ProblemItem<"financialTransactionAllocationDefects">[]> {
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
): Promise<Map<string, ProblemItem<"financialTransactionAllocationDefects">>> {
  if (shortcodes.length === 0) return new Map();
  const rows = await queryAllocationDefects(db, {
    shortcodes,
    defectsOnly: false,
  });
  return new Map(rows.map((row) => [row.id, presentAllocationDefect(row)]));
}

export async function findDuplicateFinancialAccountSourceAliases(
  db: Database,
): Promise<ProblemItem<"duplicateFinancialAccountSourceAliases">[]> {
  const result = await getDb(db).execute<{
    source: string;
    externalAccountId: string;
    accountIds: string[];
  }>(sql`
    SELECT a->>'source' AS source, a->>'externalAccountId' AS "externalAccountId", array_agg(fa.shortcode) AS "accountIds"
    FROM "FinancialAccount" fa CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fa."sourceAliases") = 'array' THEN fa."sourceAliases" ELSE '[]'::jsonb END) a
    WHERE ${notDeleted("fa")} AND a->>'externalAccountId' IS NOT NULL
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
export async function findIncompleteTransactionImports(
  db: Database,
): Promise<ProblemItem<"incompleteTransactionImports">[]> {
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
    FROM "TransactionImport" si
    LEFT JOIN ${transactionImportRecord} member ON member."importId" = si.id
    LEFT JOIN "SourceTransactionRecord" sr
      ON sr.id = member."statementRowId" AND ${notDeleted("sr")}
    WHERE ${notDeleted("si")} AND si."rowCountDeclared" IS NOT NULL
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
