import type { Amount } from "@cubby/schemas/codec";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type { ProductAddToInventoryPreviewOut } from "@cubby/schemas/product";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { inventoryEntry } from "~/server/db/schema";
import {
  amountFromColumns,
  getDb,
  notDeleted,
} from "~/server/repo/database-helpers";
import { listProductComponents } from "~/server/repo/product-components";
import { loadProductQuantitySummaries } from "~/server/repo/product/quantity-ledger";

/**
 * Complete kits the parts on shelves account for, or null when unanswerable.
 *
 * A mixed-unit part cannot be counted, so the kit's accounting is unanswerable
 * rather than zero — silence beats a wrong number. Complete kits, not loose
 * parts: a half-present kit accounts for zero, leaving the shortfall to the
 * variance cue.
 */
export const kitsAccountedByParts = (
  components: readonly { quantity: number; onHandUnits: number | null }[],
): number | null => {
  if (components.length === 0) return null;
  let complete = Number.POSITIVE_INFINITY;
  for (const component of components) {
    if (component.onHandUnits === null) return null;
    complete = Math.min(
      complete,
      Math.floor(component.onHandUnits / component.quantity),
    );
  }
  return complete;
};

/**
 * What an "add to inventory" flow proposes and warns about, so web and native
 * show one verdict. Proposals and warnings only: the operator confirms the
 * write, and nothing here decrements anything.
 */
export const describeAddToInventory = (input: {
  expectedQuantity: number;
  ownOnHandUnits: number | null;
  components: readonly { quantity: number; onHandUnits: number | null }[];
  existingAtLocation: Amount | null;
}): ProductAddToInventoryPreviewOut => {
  // A ledger with nothing outstanding (expected 0, or a shelf already at or
  // above it) falls back to one unit rather than proposing zero or less.
  const outstanding = input.expectedQuantity - (input.ownOnHandUnits ?? 0);
  const byParts = kitsAccountedByParts(input.components);
  // Only a ledger that says something can be exceeded: expected 0 means no
  // receipt was ever entered, not that nothing is owned.
  const accounted = (byParts ?? 0) + (input.ownOnHandUnits ?? 0);
  const overAccounted =
    byParts !== null &&
    input.expectedQuantity > 0 &&
    accounted >= input.expectedQuantity;
  return {
    defaultAmount: { value: outstanding > 0 ? outstanding : 1, unit: "each" },
    kitWarning: overAccounted
      ? { accounted, expected: input.expectedQuantity }
      : null,
    existingAtLocation: input.existingAtLocation,
  };
};

export const previewProductAddToInventory = async (
  db: Database,
  productId: ProductId,
  locationId: LocationId | null,
): Promise<ProductAddToInventoryPreviewOut> => {
  const [summary, components, existing] = await Promise.all([
    loadProductQuantitySummaries(db, [productId]).then((map) =>
      map.get(productId),
    ),
    listProductComponents(db, productId),
    locationId === null
      ? Promise.resolve(undefined)
      : getDb(db).query.inventoryEntry.findFirst({
          where: and(
            eq(inventoryEntry.productId, productId),
            eq(inventoryEntry.locationId, locationId),
            eq(inventoryEntry.placement, "stock"),
            notDeleted(inventoryEntry),
          ),
        }),
  ]);
  return describeAddToInventory({
    expectedQuantity: summary?.quantityLedger.expectedQuantity ?? 0,
    ownOnHandUnits: summary?.onHandUnits ?? null,
    components,
    existingAtLocation: existing ? amountFromColumns(existing) : null,
  });
};
