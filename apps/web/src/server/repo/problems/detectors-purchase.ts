/**
 * Purchase-centric Problems detectors.
 *
 * A `Purchase` is one vendor order/receipt event and its `statedTotal` is
 * what the paperwork claimed. It is NEVER summed into spend (spend is
 * `SUM(expense.cost)` over the charge's live lines), so the only thing a stated
 * total can do is agree or disagree with those lines. This module reports the
 * disagreement.
 *
 * **Advisory, not a defect.** Differences exactly explained by posted refunds
 * are filtered out as `refund_adjusted`; the remaining mismatches still require
 * human judgment. This stays non-defect in `PROBLEM_CLASS`, ships no "fix"
 * mutation, and never back-computes a cost from `statedTotal`. A charge with no
 * stated total is `"unknown"` and is excluded before comparison.
 */

import type {
  ExpenseShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  DUPLICATE_SPEND_DAY_WINDOW,
  DUPLICATE_SPEND_NAME_SIMILARITY,
  type ProblemItem,
} from "@cubby/schemas/problems";
import { type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { expense, product, purchase, vendor } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

type DuplicateSpendRow = {
  id: ExpenseShortcode;
  expenseName: string;
  cost: number;
  expenseDate: string | null;
  purchaseId: PurchaseShortcode;
  vendorName: string | null;
  purchaseDate: string | null;
  purchaseExpenseTotal: number;
  purchaseStatedTotal: number | null;
  purchaseExpenseCount: number;
  matchedOn: "expense_total" | "stated_total";
  dayDelta: number;
  nameSimilarity: number;
  alternateMatchCount: number;
};

/**
 * An unlinked Expense that is probably the same money as an itemized Purchase.
 *
 * The 2026-07/08 vendor imports minted itemized purchases for orders already
 * booked as single hand-entered lump rows in 2024. Neither side referenced the
 * other, so seven orders were counted twice ($296.61) and sat undetected for two
 * years. This is the detector that would have caught them.
 *
 * ## Why the predicates are in this order
 *
 * **Amount + date first, names only afterwards.** That ordering is load-bearing
 * twice over. Correctness: this ledger names the *thing*, not the product, so a
 * name-led search cannot find these at all — that is the trap `expense/match.ts`
 * documents at length, where a "Festool Vacuum" duplicate was created because a
 * `dust extractor` row with the identical amount and date already existed, zero
 * shared tokens. Cost: the trigram score is computed only on the handful of pairs
 * that survive the join, never across the 127k-pair cross product.
 *
 * **The name gate is a tiebreak, not a filter.** On its own it is near-useless —
 * across every orphan x purchase pair the score has mean 0.10 and p95 0.25. What
 * it does is separate true duplicates (0.217-1.000 across 21 of the 22 ever
 * resolved in this ledger, replayed) from same-amount coincidences (0.095 for a
 * $22.00 "fiskars pruners" row against an unrelated $22.00 Amazon order) and from
 * picking the *wrong* one of two purchases that share a price (0.000). Replaying
 * those 22 independently rediscovers both incidents `expense/match.ts` names — the
 * Festool dust extractor and the B&H duplicate aggregate. `word_similarity` rather than
 * `similarity` because it is asymmetric: it asks whether the terse hand-entered
 * name appears inside the verbose vendor title, which is exactly this shape —
 * "framing nails" scores 1.000 inside "...Ring Shank Round Head Framing Nails
 * 1000 per Box" but only 0.147 symmetrically. Trigrams also beat token overlap
 * here, which breaks on plurals ("outlets for garage" shares no token with
 * "Duplex Outlet/Receptacle" yet scores 0.316).
 *
 * Note this is `word_similarity()` the FUNCTION with an explicit comparison, not
 * the `<%` operator — the operator reads `pg_trgm.word_similarity_threshold`, so
 * using it would let a session GUC silently change what this detector reports.
 *
 * ## Amounts are compared in cents
 *
 * `round(x::numeric, 2)` on both sides rather than a float tolerance. The columns
 * are `double precision` and `abs(100 - 99.99)` is `0.010000000000005116`, so a
 * `<= RECONCILIATION_TOLERANCE` comparison makes a nominal exact match depend on
 * where binary floating point landed — the trap `reconcilePurchase` documents and
 * solves the same way. Equality is also the right relation here: this looks for
 * the *same money*, not an approximate one.
 *
 * Both totals are compared, and `statedTotal` is not redundant: three of the seven
 * real duplicates matched only the stated total, because the import had left those
 * purchases under-itemized — which made them the worst double-counts, not the
 * weakest hits. A null `statedTotal` yields NULL in the OR and simply drops out.
 *
 * A purchase with a stated total and **zero** live lines is deliberately out of
 * reach — the join to its lines is inner, so it never forms a pair. That is the
 * most extreme under-itemization, but it is also the one shape this detector
 * cannot judge: with no line or product names there is nothing for the trigram
 * gate to score, so a left join would only push the same row out one step later
 * (similarity 0). Admitting it would mean bypassing the gate on amount alone,
 * which is precisely the coincidence class the gate exists to reject. The shape
 * is not unreported — `empty_expenses` in the data-quality engine already flags a
 * purchase with no live expenses, which is the more accurate description of it.
 *
 * Excludes `future` rows: planned spend is not yet double-counted actual spend.
 * Deliberately does NOT exclude expenses that carry a `productId` — only 2 of 80
 * unlinked rows have one, so filtering would cost recall for nothing.
 *
 * Advisory in `PROBLEM_CLASS`, and ships no fix mutation: the remedy deletes a
 * row, which must stay a human decision.
 */
export const findDuplicateSpendCandidates = async (
  db: Database,
): Promise<ProblemItem<"duplicateSpendCandidates">[]> => {
  const cents = (value: SQL) => sql`round(${value}::numeric, 2)`;
  const expenseTotal = sql`COALESCE(sum(le."cost"), 0)`;

  const res = await getDb(db).execute<DuplicateSpendRow>(sql`
    WITH orphan AS (
      SELECT e."shortcode", e."name", e."cost", e."date"
      FROM ${expense} e
      WHERE e."deletedAt" IS NULL
        AND e."purchaseId" IS NULL
        AND e."future" IS NOT TRUE
        AND e."cost" IS NOT NULL
        AND e."cost" <> 0
    ),
    purchase_total AS (
      SELECT
        p."id",
        p."shortcode",
        p."date",
        p."statedTotal",
        v."name" AS "vendorName",
        ${expenseTotal}::double precision AS "expenseTotal",
        count(le."id")::int AS "expenseCount"
      FROM ${purchase} p
      LEFT JOIN ${vendor} v
        ON v."id" = p."vendorId" AND v."deletedAt" IS NULL
      LEFT JOIN ${expense} le
        ON le."purchaseId" = p."id" AND le."deletedAt" IS NULL
      WHERE p."deletedAt" IS NULL
      GROUP BY p."id", p."shortcode", p."date", p."statedTotal", v."name"
    ),
    pair AS (
      SELECT
        o."shortcode" AS "id",
        o."name" AS "expenseName",
        o."cost"::double precision AS "cost",
        o."date"::text AS "expenseDate",
        t."shortcode" AS "purchaseId",
        t."vendorName",
        t."date"::text AS "purchaseDate",
        t."expenseTotal" AS "purchaseExpenseTotal",
        t."statedTotal"::double precision AS "purchaseStatedTotal",
        t."expenseCount" AS "purchaseExpenseCount",
        abs(o."date" - t."date")::int AS "dayDelta",
        CASE
          WHEN ${cents(sql`o."cost"`)} = ${cents(sql`t."expenseTotal"`)}
          THEN 'expense_total' ELSE 'stated_total'
        END AS "matchedOn",
        max(greatest(
          word_similarity(o."name", le."name"),
          word_similarity(o."name", COALESCE(pd."name", ''))
        ))::double precision AS "nameSimilarity"
      FROM orphan o
      JOIN purchase_total t
        ON abs(o."date" - t."date") <= ${DUPLICATE_SPEND_DAY_WINDOW}
       AND (
            ${cents(sql`o."cost"`)} = ${cents(sql`t."expenseTotal"`)}
         OR ${cents(sql`o."cost"`)} = ${cents(sql`t."statedTotal"`)}
       )
      JOIN ${expense} le
        ON le."purchaseId" = t."id" AND le."deletedAt" IS NULL
      LEFT JOIN ${product} pd
        ON pd."id" = le."productId" AND pd."deletedAt" IS NULL
      GROUP BY
        o."shortcode", o."name", o."cost", o."date",
        t."shortcode", t."vendorName", t."date",
        t."expenseTotal", t."statedTotal", t."expenseCount"
    ),
    ranked AS (
      SELECT
        pair.*,
        row_number() OVER (
          PARTITION BY "id" ORDER BY "nameSimilarity" DESC, "dayDelta"
        ) AS "rn",
        (count(*) OVER (PARTITION BY "id") - 1)::int AS "alternateMatchCount"
      FROM pair
      WHERE "nameSimilarity" >= ${DUPLICATE_SPEND_NAME_SIMILARITY}
    )
    SELECT * FROM ranked WHERE "rn" = 1 ORDER BY abs("cost") DESC
  `);

  return res.rows.map((row) => ({
    id: row.id,
    expenseName: row.expenseName,
    cost: Number(row.cost),
    expenseDate: row.expenseDate,
    purchaseId: row.purchaseId,
    vendorName: row.vendorName,
    purchaseDate: row.purchaseDate,
    purchaseExpenseTotal: Number(row.purchaseExpenseTotal),
    purchaseStatedTotal:
      row.purchaseStatedTotal === null ? null : Number(row.purchaseStatedTotal),
    purchaseExpenseCount: Number(row.purchaseExpenseCount),
    matchedOn: row.matchedOn,
    dayDelta: Number(row.dayDelta),
    nameSimilarity: Number(row.nameSimilarity),
    alternateMatchCount: Number(row.alternateMatchCount),
  }));
};
