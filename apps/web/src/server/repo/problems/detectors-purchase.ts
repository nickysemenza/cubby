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

import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import type { PurchaseNotReconciling } from "@cubby/schemas/problems";
import {
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { expense, purchase, vendor } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/** What the grouped scan yields before the shared verdict is applied. */
type ChargeSumRow = {
  id: PurchaseShortcode;
  vendorName: string | null;
  orderUrlTemplate: string | null;
  orderId: string | null;
  date: string | null;
  statedTotal: number;
  expenseTotal: number;
  expenseCount: number;
  unpricedExpenseCount: number;
  postedRefundTotal: number;
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
 * `reconcilePurchase` — the same verdict function the list column and the Purchase
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
export const findPurchasesNotReconciling = async (
  db: Database,
): Promise<PurchaseNotReconciling[]> => {
  const lineTotal = sql`COALESCE(sum(e."cost"), 0)`;
  const res = await getDb(db).execute<ChargeSumRow>(sql`
    SELECT
      p."shortcode" AS "id",
      v."name" AS "vendorName",
      v."orderUrlTemplate" AS "orderUrlTemplate",
      p."orderId" AS "orderId",
      p."date"::text AS "date",
      p."statedTotal" AS "statedTotal",
      ${lineTotal} AS "expenseTotal",
      count(e.id)::int AS "expenseCount",
      count(e.id) FILTER (WHERE e.cost IS NULL)::int AS "unpricedExpenseCount",
      COALESCE((
        SELECT sum(ft.amount)
        FROM "FinancialTransaction" ft
        WHERE ft."purchaseId" = p.id
          AND ft.kind = 'refund'
          AND ft.status = 'posted'
          AND ft."deletedAt" IS NULL
      ), 0)::double precision AS "postedRefundTotal"
    FROM ${purchase} p
    LEFT JOIN ${vendor} v
      ON v.id = p."vendorId" AND v."deletedAt" IS NULL
    LEFT JOIN ${expense} e
      ON e."purchaseId" = p.id AND e."deletedAt" IS NULL
    WHERE p."deletedAt" IS NULL AND p."statedTotal" IS NOT NULL
    GROUP BY p.id, v."name", v."orderUrlTemplate"
    HAVING abs(p."statedTotal" - ${lineTotal}) > ${RECONCILIATION_TOLERANCE}
    ORDER BY abs(p."statedTotal" - ${lineTotal}) DESC, p."date" DESC NULLS LAST
  `);

  return res.rows
    .map((row) => ({
      id: row.id,
      vendorName: row.vendorName,
      orderId: row.orderId,
      orderUrl: purchaseOrderUrl({
        orderUrlTemplate: row.orderUrlTemplate,
        orderId: row.orderId,
      }),
      date: row.date,
      statedTotal: Number(row.statedTotal),
      expenseTotal: Number(row.expenseTotal),
      expenseCount: Number(row.expenseCount),
      unpricedExpenseCount: Number(row.unpricedExpenseCount),
      postedRefundTotal: Number(row.postedRefundTotal),
    }))
    .filter((row) => reconcilePurchase(row) === "mismatch");
};
