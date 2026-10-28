import {
  financialTransactionKind,
  SETTLEMENT_CANDIDATE_LIMIT,
} from "@cubby/schemas/financial-transaction";
import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { cents, parseShortcode } from "@cubby/shared";
import { and, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, notDeleted, unwrapDb } from "~/server/db/helpers";
import { purchase as purchaseTable } from "~/server/db/schema";
import {
  type SettlementConflictKind,
  settlementConflictKinds,
  settlementConflictSql,
} from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import { createAppError } from "~/server/errors/app-error";

/** Eligibility and rank apply to the full live set before the advisory limit.
 * Allocation mutations remain authoritative when a suggestion is reviewed.
 */
export async function listPurchaseSettlementCandidates(
  db: Database,
  purchaseId: PurchaseShortcode,
) {
  return (
    (await listPurchasesSettlementCandidates(db, [purchaseId])).get(
      purchaseId,
    ) ?? []
  );
}

const candidateRow = z.object({
  purchaseCode: z.string(),
  transactionId: z.string(),
  days: z.number(),
  merchantMatches: z.boolean(),
  exactAmount: z.boolean(),
  nearAmount: z.boolean(),
  partyConflict: z.boolean(),
  tenderConflict: z.boolean(),
});

/**
 * `listPurchaseSettlementCandidates` for several Purchases in one ranked
 * statement: each Purchase's search is a LATERAL over its own facts, so the
 * conflict predicates are planned once rather than once per Purchase.
 */
export async function listPurchasesSettlementCandidates(
  db: Database,
  purchaseIds: readonly PurchaseShortcode[],
) {
  const codes = uniq(purchaseIds);
  const parsed = new Map(
    codes.map((code) => [code, parseShortcode(code)] as const),
  );
  const shortcodes = [...parsed.values()].flatMap((value) =>
    value?.type === "purchase" ? [value.shortcode] : [],
  );
  // Only the facts ranking reads: a full Purchase read planned its whole
  // detail projection for every connection freshness check.
  const facts = shortcodes.length
    ? await getDb(db)
        .select({
          shortcode: purchaseTable.shortcode,
          date: purchaseTable.date,
          statedTotal: purchaseTable.statedTotal,
          vendorName: sql<string | null>`(SELECT v."name" FROM "Vendor" v
            WHERE v."id" = ${purchaseTable.vendorId} AND ${notDeleted("v")})`,
        })
        .from(purchaseTable)
        .where(
          and(
            inArray(purchaseTable.shortcode, shortcodes),
            notDeleted(purchaseTable),
          ),
        )
    : [];
  const byShortcode = new Map(facts.map((row) => [row.shortcode, row]));
  const subjects = codes.map((code) => {
    const value = parsed.get(code);
    const row =
      value?.type === "purchase" ? byShortcode.get(value.shortcode) : undefined;
    if (!row) throw createAppError("PURCHASE_NOT_FOUND", "Purchase not found");
    return { code, ...row };
  });
  const out = new Map<string, Candidate[]>(codes.map((code) => [code, []]));
  const dated = subjects.filter((subject) => subject.date !== null);
  if (dated.length === 0) return out;

  const subjectRows = sql.join(
    dated.map(
      (subject, ordinal) =>
        sql`(${ordinal}::int, ${subject.code}::text, ${subject.date}::date,
          ${subject.statedTotal === null ? null : cents(subject.statedTotal)}::numeric,
          ${subject.vendorName}::text)`,
    ),
    sql`, `,
  );
  const effectiveDate = sql`coalesce("FinancialTransaction"."postedDate", "FinancialTransaction"."transactionDate")::date`;
  const days = sql`abs(${effectiveDate} - subject.date)`;
  const residual = sql`("FinancialTransaction".amount - (
    SELECT coalesce(sum(a.amount), 0) FROM "FinancialTransactionAllocation" a
    WHERE a."transactionId" = "FinancialTransaction".id AND ${notDeleted("a")}
  ))`;
  const targetAllocation = sql`EXISTS (
    SELECT 1 FROM "FinancialTransactionAllocation" a
    JOIN "Purchase" p ON p.id = a."purchaseId" AND ${notDeleted("p")}
    WHERE a."transactionId" = "FinancialTransaction".id AND ${notDeleted("a")}
      AND p.shortcode = subject.code
  )`;
  // POSITION treats source merchant text literally, including '%' and '_'.
  const merchantMatches = sql`(
    subject.vendor_name IS NOT NULL AND length(subject.vendor_name) > 0
    AND position(lower(subject.vendor_name) in lower(coalesce("FinancialTransaction".merchant, ''))) > 0
  )`;
  const centsOff = (amount: SQL) =>
    sql`abs(round((${amount} * 100)::numeric) - subject.stated_cents)`;
  const amountWithin = (centsAllowed: number) => sql`(
    "FinancialTransaction".kind = ${financialTransactionKind.enum.purchase}
    AND subject.stated_cents IS NOT NULL
    AND (${centsOff(sql`"FinancialTransaction".amount`)} <= ${centsAllowed}
      OR ${centsOff(residual)} <= ${centsAllowed})
  )`;
  const exactAmount = amountWithin(0);
  const nearAmount = sql`(${amountWithin(1)} AND NOT ${exactAmount})`;
  const conflictWith = (kind: SettlementConflictKind) => sql`EXISTS (
    SELECT 1 FROM "Purchase" settle_target
    WHERE settle_target.shortcode = subject.code
      AND ${notDeleted("settle_target")}
      AND ${settlementConflictSql(kind, {
        purchase: "settle_target",
        account: '"FinancialAccount"',
        transaction: '"FinancialTransaction"',
      })}
  )`;
  const result = await unwrapDb(db).execute(sql`
    SELECT subject.code AS "purchaseCode", ranked."transactionId", ranked.days,
      ranked."merchantMatches", ranked."exactAmount", ranked."nearAmount",
      ranked."partyConflict", ranked."tenderConflict"
    FROM (VALUES ${subjectRows}) subject(ordinal, code, date, stated_cents, vendor_name)
    CROSS JOIN LATERAL (
      SELECT scored.*, row_number() OVER (ORDER BY
        (scored."partyConflict" OR scored."tenderConflict") ASC,
        scored."exactAmount" DESC, scored."nearAmount" DESC,
        scored."merchantMatches" DESC, scored.days ASC,
        scored."transactionId" ASC) AS rank
      FROM (
        SELECT "FinancialTransaction".shortcode AS "transactionId",
          ${days} AS days, ${merchantMatches} AS "merchantMatches",
          ${exactAmount} AS "exactAmount", ${nearAmount} AS "nearAmount",
          ${conflictWith("party")} AS "partyConflict",
          ${conflictWith("tender")} AS "tenderConflict"
        FROM "FinancialTransaction"
        JOIN "FinancialAccount" ON "FinancialAccount".id = "FinancialTransaction"."accountId"
        WHERE ${notDeleted("FinancialTransaction")}
          AND ${notDeleted("FinancialAccount")}
          AND "FinancialTransaction".status <> 'void'
          AND "FinancialTransaction"."ledgerTransferId" IS NULL
          AND "FinancialTransaction".kind IN ('purchase', 'refund')
          AND ${days} <= 45
          AND ((${residual} <> 0 AND sign(${residual}) = sign("FinancialTransaction".amount)) OR ${targetAllocation})
      ) scored
      ORDER BY rank
      LIMIT ${SETTLEMENT_CANDIDATE_LIMIT}
    ) ranked
    ORDER BY subject.ordinal, ranked.rank`);
  for (const row of z.array(candidateRow).parse(result.rows)) {
    const { purchaseCode, partyConflict, tenderConflict, ...candidate } = row;
    out.get(purchaseCode)?.push({
      ...candidate,
      conflicts: settlementConflictKinds.filter((kind) =>
        kind === "party" ? partyConflict : tenderConflict,
      ),
    });
  }
  return out;
}

type Candidate = {
  transactionId: string;
  days: number;
  merchantMatches: boolean;
  exactAmount: boolean;
  nearAmount: boolean;
  conflicts: SettlementConflictKind[];
};
