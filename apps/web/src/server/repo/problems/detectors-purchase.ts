/**
 * Purchase-centric Problems detectors.
 *
 * A `Purchase` is ONE vendor transaction — a charge — and its `statedTotal` is
 * what the paperwork claimed. It is NEVER summed into spend (spend is
 * `SUM(expense.cost)` over the charge's live lines), so the only thing a stated
 * total can do is agree or disagree with those lines. This module reports the
 * disagreement.
 *
 * **Advisory, not a defect.** A mismatch is frequently CORRECT: a partial refund
 * reduces a line without changing what the charge originally stated. So this is
 * classed non-defect in `PROBLEM_CLASS` (it never counts toward `totalProblems`
 * and never turns the navbar badge red), it ships no "fix" mutation, and nothing
 * here — or anywhere else in the system — back-computes a cost from
 * `statedTotal`. A charge with no stated total is `"unknown"`, not a problem, and
 * is excluded before the comparison ever happens.
 */

import type { PurchaseId, PurchaseShortcode } from "@cubby/schemas/identifiers";
import type { ChargeNotReconciling } from "@cubby/schemas/problems";
import {
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { expense, purchase, vendor } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/** What the grouped scan yields before the shared verdict is applied. */
type ChargeSumRow = {
  id: PurchaseId;
  shortcode: PurchaseShortcode;
  vendorName: string | null;
  orderId: string | null;
  date: string | null;
  statedTotal: number;
  expenseTotal: number;
  expenseCount: number;
};

/**
 * Charges whose live lines don't add up to what the charge said it was.
 *
 * Detector-shaped, unlike the `purchase.notReconciling` router read it
 * supersedes: the comparison is a `HAVING` over the charge's line sum, so this
 * returns only offenders instead of pulling every charge that has a stated total
 * and filtering in JS. One grouped scan of `Purchase ⋈ Vendor ⋈ Expense`, no
 * WASM and no network — hence the `fast` detector group.
 *
 * The tolerance is IMPORTED, not restated: the `HAVING` interpolates
 * `RECONCILIATION_TOLERANCE`, and every surviving row is then put through
 * `reconcilePurchase` — the same verdict function the list column and the charge
 * detail page use. The SQL narrows; that function decides. Both operands are
 * `double precision`, so PG and JS are doing IEEE-754 arithmetic on the same
 * bits and the two agree; the JS pass exists so a future change to the verdict
 * (a different tolerance, a percentage band) can't leave this detector reporting
 * rows the rest of the app calls a match.
 *
 * `p."date"::text` because this is raw SQL: the `date` column's Drizzle
 * `mode: "string"` mapping doesn't apply, and pg's default DATE parser would
 * hand back a `Date` object where the wire contract is a `YYYY-MM-DD` string.
 *
 * Ordered by the size of the discrepancy, largest first — this is a worklist,
 * and a $400 gap is worth looking at before a $2 one.
 */
export const findChargesNotReconciling = async (
  db: Database,
): Promise<ChargeNotReconciling[]> => {
  const lineTotal = sql`COALESCE(sum(e."cost"), 0)`;
  const res = await getDb(db).execute<ChargeSumRow>(sql`
    SELECT
      p.id AS "id",
      p."shortcode" AS "shortcode",
      v."name" AS "vendorName",
      p."orderId" AS "orderId",
      p."date"::text AS "date",
      p."statedTotal" AS "statedTotal",
      ${lineTotal} AS "expenseTotal",
      count(e.id)::int AS "expenseCount"
    FROM ${purchase} p
    LEFT JOIN ${vendor} v
      ON v.id = p."vendorId" AND v."deletedAt" IS NULL
    LEFT JOIN ${expense} e
      ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
    WHERE p."deletedAt" IS NULL AND p."statedTotal" IS NOT NULL
    GROUP BY p.id, v."name"
    HAVING abs(p."statedTotal" - ${lineTotal}) > ${RECONCILIATION_TOLERANCE}
    ORDER BY abs(p."statedTotal" - ${lineTotal}) DESC, p."date" DESC NULLS LAST
  `);

  return res.rows
    .map((row) => ({
      id: row.id,
      shortcode: row.shortcode,
      vendorName: row.vendorName,
      orderId: row.orderId,
      date: row.date,
      statedTotal: Number(row.statedTotal),
      expenseTotal: Number(row.expenseTotal),
      expenseCount: Number(row.expenseCount),
    }))
    .filter((row) => reconcilePurchase(row) === "mismatch");
};
