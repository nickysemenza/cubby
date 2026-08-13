import type { InventoryPlacement } from "@cubby/schemas/inventory";
import { eq, type SQL, sql } from "drizzle-orm";
import { inventoryEntry } from "~/server/db/schema";

/**
 * Placement predicates — the single source of truth for what `installed` means
 * to a query.
 *
 * An `installed` entry is a fixed installation: the Forbes & Lomax dimmer wired
 * into the kitchen wall, the recessed cans in the ceiling, the faucet on the
 * sink. It is a record worth keeping and never worth looking at while browsing.
 *
 * ## The rule, so each call site is a deduction rather than a taste call
 *
 * **Counting, auditing, browsing, staleness → EXCLUDE.** An installed row is
 * not stock you can walk over and count. Including it makes a location card
 * read 17 while the recount offers 3, and permanently caps the audit-coverage
 * meter below 100% because a fixture can never be verified.
 *
 * **Ownership, provenance, pricing, enrichment, identity, move, merge →
 * INCLUDE.** You still own the faucet, you still bought it, it still needs a
 * price and an image, and it must still be findable and mergeable.
 *
 * The single most important INCLUDE is `onHandUnitsSql`
 * (`product/quantity-ledger.ts`), and it is decided by the *other* half of the
 * ledger rather than by taste: `expectedQuantitySql` sums Expense rows, and the
 * dimmer's purchase Expense is one of them. Excluding installed rows from
 * on-hand would manufacture a permanent negative variance and light "Shelf
 * disagrees" forever on every fixture in the house.
 *
 * ## Why a per-query predicate rather than one default
 *
 * Same reason as `notDeleted()`: `inventoryentryList` is 2 of ~24 read paths and
 * none of the 3 that can destroy data, ~9 surfaces must genuinely include
 * installed rows, and a single default would make the change merely *look*
 * done. Every site is greppable for `placement`, and `scripts/check-placement-filters.mjs`
 * fails any query over `inventoryEntry` carrying neither a predicate from here
 * nor an `// includes-installed: <reason>` comment.
 */

/** Movable stock only — the browse/count/audit contract. */
export const stockOnly = (): SQL => eq(inventoryEntry.placement, "stock");

/** Fixed installations only — the disclosed "+N installed" companion query. */
export const installedOnly = (): SQL =>
  eq(inventoryEntry.placement, "installed");

/**
 * Apply a tri-state filter value. `"all"` returns undefined (unrestricted),
 * following the repo rule that an absent constraint never narrows.
 *
 * Callers own the DEFAULT — `inventoryentryList` substitutes `"stock"` for an
 * omitted filter server-side, so the UI, MCP `list_inventory`, and direct tRPC
 * callers cannot disagree about what an empty filter means.
 */
export const placementCondition = (
  filter: InventoryPlacement | "all" | undefined,
): SQL | undefined => {
  if (filter === undefined || filter === "all") return undefined;
  return eq(inventoryEntry.placement, filter);
};

/**
 * Raw-SQL counterpart for the ~7 surfaces that hand-write their own
 * `"InventoryEntry"` SQL rather than going through Drizzle conditions
 * (`quantity-ledger.ts`, the location rollups, `makeTree`).
 *
 * `alias` is the SQL identifier the surrounding query gave the table, already
 * quoted — e.g. `'"InventoryEntry"'` or `'ie'`. Emitted as a bare predicate so
 * it can be `AND`-ed into an existing `WHERE`.
 */
export const stockOnlySqlFor = (alias: string): SQL =>
  sql.raw(`${alias}."placement" = 'stock'`);
