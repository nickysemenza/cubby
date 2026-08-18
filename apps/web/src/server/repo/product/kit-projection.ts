/**
 * Projecting a kit's ledger down into the parts it contains.
 *
 * A kit or multi-pack keeps its OWN Expense — buying a 9-piece combo kit is one
 * $199 line against the kit Product, and it is never split into nine per-part
 * expenses. `ProductComponent` says what came out of it, and this module is how
 * that edge carries money and units to the parts:
 *
 *   componentShare = parentKnownCost × qtyᵢ / Σqty(that parent's live components)
 *   componentUnits = parentKnownUnits × qtyᵢ
 *
 * Cost is divided by the sibling total and units are not, which is what makes
 * the two agree: nine single-quantity parts of a $199 kit each derive
 * $199/9 = $22.11 for one unit, and a 4-pack recorded as one row with
 * `quantity: 4` derives the whole $20 spread over four units — $5 each. It is
 * deliberately an approximation. A "correct" per-part price inside a bundle is
 * usually a guess, and `Product.price` is the escape hatch for the case where a
 * real ratio is known and worth recording.
 *
 * The walk is UPWARD, from each target product through the kits it is listed
 * inside, carrying two multiplicative weights:
 *
 *   costWeight = Π (qty / Σqty)   unitWeight = Π qty
 *
 * so a target's projected total is `Σ over ancestor paths (ancestor's own
 * aggregate × that path's weight)`. That is algebraically identical to pushing
 * each kit's blended total down into its parts one level at a time — the
 * projection is linear, so distributing it over paths changes nothing — but it
 * is the shape a *correlated scalar* can afford: the recursion touches only one
 * product's ancestors, not the whole catalog, so the same fragment serves both
 * the batch loaders and the raw-SQL twins the Product list sorts and filters by.
 *
 * Two things a reader of the generated SQL should expect:
 *
 *  - **Every kit on a path is live.** Each step joins the parent Product and
 *    requires it live, the edge itself must be undeleted, and the sibling total
 *    counts only live components — so detaching or deleting a part reweights its
 *    siblings rather than leaking a share into nothing.
 *
 *  - **Depth is capped, and exceeding the cap stops projecting rather than
 *    erroring.** See {@link MAX_KIT_PROJECTION_DEPTH}.
 */

import type { ProductId } from "@cubby/schemas/identifiers";
import { type SQL, sql } from "drizzle-orm";
import { uuidArrayParam } from "~/server/repo/database-helpers";

/**
 * How many kit hops a projection will walk before it stops.
 *
 * `ProductComponent` has a CHECK against the one-row self-reference and the
 * merge path has a write-time reachability guard, but neither makes a longer
 * cycle (A contains B contains A) unrepresentable in rows that already exist —
 * and a read path that assumed a clean graph would spin forever inside a
 * `WITH RECURSIVE`. So the recursion carries a depth and refuses to extend a
 * path past this many hops.
 *
 * Exceeding it is not an error: the over-long paths are simply never generated,
 * so a cyclic graph yields a bounded, finite (if meaningless) projection and a
 * legitimately deep nesting yields the first four levels. Failing closed here
 * means a bad row costs a wrong number on one product, not a hung Product list.
 *
 * Four is chosen to be generous against reality — a kit inside a kit is already
 * exotic and nothing in the ledger nests past two — while keeping the worst-case
 * fan-out of a correlated scalar bounded by a small constant.
 */
export const MAX_KIT_PROJECTION_DEPTH = 4;

/**
 * Σ quantity over one parent's LIVE components — the denominator of the share.
 *
 * Correlated rather than a grouped CTE on purpose: this fragment is dropped
 * into scalar subqueries that run per row of the Product list, and
 * `ProductComponent_parentProductId_idx` makes it an index scan over a handful
 * of rows. A grouped CTE would be re-derived per row instead.
 */
const liveSiblingQuantitySum = (parentExpr: string) =>
  `(SELECT sum(ksib."quantity")
      FROM "ProductComponent" ksib
      JOIN "Product" ksibp
        ON ksibp."id" = ksib."componentProductId"
       AND ksibp."deletedAt" IS NULL
     WHERE ksib."parentProductId" = ${parentExpr}
       AND ksib."deletedAt" IS NULL)`;

/**
 * The recursive term. One copy, shared by every projection in every consumer:
 * this is the "keep the four copies in agreement" clause made structural rather
 * than aspirational.
 */
const KIT_ANCESTOR_STEP = `SELECT ka.target,
           kpc."parentProductId",
           ka."costWeight" * kpc."quantity"::numeric
             / NULLIF(${liveSiblingQuantitySum(`kpc."parentProductId"`)}, 0),
           ka."unitWeight" * kpc."quantity",
           ka.depth + 1
      FROM kit_anc ka
      JOIN "ProductComponent" kpc
        ON kpc."componentProductId" = ka."productId"
       AND kpc."deletedAt" IS NULL
      JOIN "Product" kparent
        ON kparent."id" = kpc."parentProductId"
       AND kparent."deletedAt" IS NULL
     WHERE ka.depth < ${MAX_KIT_PROJECTION_DEPTH}`;

/**
 * `(target, "productId", "costWeight", "unitWeight", depth)`. Naming the columns
 * on the CTE frees every seed from having to label them, and `depth = 0` is what
 * marks a row as the product's own contribution rather than a projected one.
 */
const KIT_ANCESTOR_COLUMNS = `(target, "productId", "costWeight", "unitWeight", depth)`;

const cteOpen = `WITH RECURSIVE kit_anc ${KIT_ANCESTOR_COLUMNS} AS (`;
const cteClose = `UNION ALL ${KIT_ANCESTOR_STEP})`;

/** The CTE as raw text, for the hand-qualified correlated scalars. */
export const kitAncestorCteText = (seed: string) =>
  `${cteOpen} ${seed} ${cteClose}`;

/** The same CTE with a bound seed, for the batch loaders. */
export const kitAncestorCteSql = (seed: SQL): SQL =>
  sql`${sql.raw(cteOpen)} ${seed} ${sql.raw(cteClose)}`;

/**
 * Seed one product, correlated to the enclosing query's alias. No FROM: the id
 * is an outer reference, which is exactly what makes the recursion touch only
 * this product's ancestors.
 */
export const kitSeedForProductAlias = (productAlias: string) =>
  `SELECT ${productAlias}."id", ${productAlias}."id", 1::numeric, 1::numeric, 0`;

/**
 * Seed a batch. `wholeCatalog` drops the id filter — pass it only when `ids`
 * already IS every live product (see `loadProductPricing`'s note).
 *
 * Deliberately NOT filtered on the target's own liveness: "what did this cost"
 * and "how many should there be" stay answerable for a soft-deleted product,
 * which is what the grouped queries this replaced did. Liveness is enforced
 * where it changes an answer — on every ancestor hop, and on the siblings whose
 * quantities set the denominator.
 */
export const kitSeedForProductIds = (
  ids: readonly ProductId[],
  wholeCatalog = false,
): SQL =>
  sql`SELECT kp."id", kp."id", 1::numeric, 1::numeric, 0
        FROM "Product" kp ${
          wholeCatalog
            ? sql.empty()
            : sql`WHERE kp."id" = ANY(${uuidArrayParam(ids)})`
        }`;

/**
 * `FROM kit_anc ka JOIN LATERAL (<own aggregate>) ko ON true`.
 *
 * The lateral body is the consumer's own per-product Expense aggregate, keyed on
 * `ka."productId"`; it is what differs between the money side (`pricing.ts`) and
 * the units side (`quantity-ledger.ts`), and it is all that differs. An
 * aggregate-only subquery always yields exactly one row, so a product with no
 * Expense rows still produces its `depth = 0` row with NULL sums — which the
 * outer `sum` skips and `COALESCE` reads as zero.
 */
export const kitProjectionFrom = (ownAggregate: string) =>
  `FROM kit_anc ka JOIN LATERAL (${ownAggregate}) ko ON true`;

/**
 * Weighted projections of one lateral-aggregate column.
 *
 * `costWeighted` casts through numeric because `Expense.cost` is
 * `double precision` and the weights are `numeric` — Postgres has no
 * `double precision * numeric` operator, and the cast is the fix, not a
 * rounding decision.
 */
export const costWeighted = (column: string) =>
  `sum(ko.${column}::numeric * ka."costWeight")`;

export const unitWeighted = (column: string) =>
  `sum(ko.${column} * ka."unitWeight")`;

/** Own-only: a projected row must not inflate a count of THIS product's lines. */
export const ownOnly = (column: string) =>
  `sum(ko.${column}) FILTER (WHERE ka.depth = 0)`;

/** `db.execute` returns a pg `QueryResult`; older drivers hand back the array. */
export const projectionRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
};
