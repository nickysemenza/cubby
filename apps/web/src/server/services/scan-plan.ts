/**
 * What should happen when a product code is scanned at a location.
 *
 * Pure: facts in, decision out. No DB, no transport, no clock. The scan service
 * gathers the facts and executes the plan; keeping the branching here is what
 * makes every outcome a unit test instead of an integration fixture.
 *
 * The semantics are a *presence sweep*, not a count. Scanning something already
 * on this shelf confirms it rather than incrementing it, so sweeping the same
 * bookshelf twice changes nothing. That is deliberate and load-bearing: books
 * created from an ISBN get `expectedQuantity: null` (see
 * product-orchestration.service), so any "not a one-of-a-kind item, therefore
 * add another" rule would double a shelf on its first honest re-sweep.
 *
 * Absence stays out of scope. A row that is never scanned is never touched —
 * only an explicit recount closes the world.
 */

import type { Amount } from "@cubby/schemas/codec";
import type {
  InventoryShortcode,
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";

/**
 * One live stock row for the scanned product.
 *
 * Stock only. `placement: "installed"` rows are filtered out before they get
 * here — a faucet plumbed into a wall is not a stray to be pulled onto a shelf,
 * and the caller that forgets this is the bug the filter exists to prevent.
 */
interface ScanStockRow {
  id: InventoryShortcode;
  amount: Amount;
  location: { id: LocationShortcode; name: string };
}

export interface ScanFacts {
  product: { id: ProductShortcode; name: string };
  /** Every live stock row for this product, at any location. */
  stock: readonly ScanStockRow[];
}

/**
 * A row of this product sitting somewhere other than where it was just scanned.
 * Never acted on during the sweep — it queues for the end-of-sweep review.
 */
interface ScanStray {
  entryId: InventoryShortcode;
  location: { id: LocationShortcode; name: string };
  amount: Amount;
  /**
   * More than one unit sits in the source row, so "move it here" is genuinely
   * ambiguous: the scan proves one object moved, not five. These need an
   * explicit move-one-or-all choice; single-unit rows move whole silently.
   */
  ambiguousQuantity: boolean;
}

export type ScanPlan =
  /** Nothing of this product is stocked anywhere. Create a row here. */
  | { kind: "add"; product: ScanFacts["product"]; strays: readonly [] }
  /**
   * It is already here. Stamp `verifiedAt` and leave the amount alone. Strays
   * elsewhere still queue — a copy on this shelf says nothing about the copy
   * in the other room.
   */
  | {
      kind: "confirm";
      product: ScanFacts["product"];
      entryId: InventoryShortcode;
      strays: readonly ScanStray[];
    }
  /** Stocked only elsewhere. Nothing is written now; the strays queue. */
  | {
      kind: "decide";
      product: ScanFacts["product"];
      strays: readonly ScanStray[];
    };

export function planScan(
  facts: ScanFacts,
  currentLocationId: LocationShortcode,
): ScanPlan {
  const here = facts.stock.find((row) => row.location.id === currentLocationId);
  const strays = facts.stock
    .filter((row) => row.location.id !== currentLocationId)
    .map((row): ScanStray => ({
      entryId: row.id,
      location: row.location,
      amount: row.amount,
      ambiguousQuantity: row.amount.value > 1,
    }));

  if (here) {
    return {
      kind: "confirm",
      product: facts.product,
      entryId: here.id,
      strays,
    };
  }
  if (strays.length > 0) {
    return { kind: "decide", product: facts.product, strays };
  }
  return { kind: "add", product: facts.product, strays: [] };
}
