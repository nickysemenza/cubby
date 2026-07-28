/**
 * Shared purchase-aggregate SQL fragments, used by BOTH
 * `purchase/analytics.ts` (the ledger's own breakdowns) and
 * `project/portfolio-analytics.ts` (the project-scoped chart aggregates).
 *
 * Lives at the repo root rather than inside either `purchase/` or `project/`
 * on purpose: `repo/purchase/*` already imports from `repo/project/*` in one
 * direction (`purchase/crud.ts` imports the project barrel for
 * `assertProjectLive`; `purchase/lookup.ts` imports `project/subtree` for its
 * project-presence condition). Adding the reverse edge — either analytics
 * file importing the other's directory directly — would put `repo/project`
 * and `repo/purchase` in a bidirectional relationship. This module imports
 * only drizzle + the schema, so it can't sit on a cycle either way, matching
 * the precedent of other repo-root files that span multiple entities (e.g.
 * `repo/dashboard.ts`).
 */
import { sql } from "drizzle-orm";
import { purchase } from "~/server/db/schema";

/**
 * actual/committed/credits/net/count — the shared aggregate columns every
 * purchase-based breakdown selects. `actual` = live spend already made,
 * `committed` = future/planned spend, `credits` = refunds & contributions
 * (stored as negative `cost`, flipped positive here). `net` is the
 * purchase's blended total — algebraically `actual + committed - credits`,
 * which telescopes to a plain `sum(cost)` (cost = 0 and NULL cost both
 * contribute nothing to any of the three either). Computed directly as one
 * sum rather than three-way arithmetic to keep the query plan cheap.
 *
 * Negative purchases are real in this app (refunds, and large negative
 * family contributions) — the `filter (where cost > 0 …)` / credits split
 * is load-bearing. Do not "simplify" the sign handling.
 *
 * A fresh object is returned per call since these `sql` fragments get spread
 * into several independent `select()`s across both callers.
 */
export const purchaseAggregateFields = () => ({
  actual: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.cost} > 0 and ${purchase.future} = false), 0)::float`,
  committed: sql<number>`coalesce(sum(${purchase.cost}) filter (where ${purchase.cost} > 0 and ${purchase.future} = true), 0)::float`,
  credits: sql<number>`coalesce(-sum(${purchase.cost}) filter (where ${purchase.cost} < 0), 0)::float`,
  net: sql<number>`coalesce(sum(${purchase.cost}), 0)::float`,
  count: sql<number>`count(*)::int`,
});

/** `"YYYY-MM"` bucket expression, reused for both the SELECT and its GROUP/ORDER BY. */
export const PURCHASE_MONTH_BUCKET = sql<string>`to_char(${purchase.date}, 'YYYY-MM')`;
