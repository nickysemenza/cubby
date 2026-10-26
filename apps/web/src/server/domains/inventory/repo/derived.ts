/**
 * Inventory's stored valuation (ADR 0021). The unit-mapping graph is WASM, so
 * SQL cannot value a row; the drain values changed rows here and lists read
 * the published figure for sort, filter and footer totals.
 */
import type { InventoryId } from "@cubby/schemas/identifiers";
import { and, inArray } from "drizzle-orm";

import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { inventoryEntry } from "~/server/db/schema";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

import { loadInventoryValuations } from "./valuation";

const inventoryValuationCompute: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({
      id: inventoryEntry.id,
      productId: inventoryEntry.productId,
      amountValue: inventoryEntry.amountValue,
      amountUnit: inventoryEntry.amountUnit,
    })
    .from(inventoryEntry)
    .where(
      and(
        // SAFETY: the drain passes ids of `inventory.valuation` marks only.
        inArray(inventoryEntry.id, ids as InventoryId[]),
        notDeleted(inventoryEntry),
      ),
    );
  const valuations = await loadInventoryValuations(db, rows);
  const out = new Map<string, DerivedComputed>();
  for (const row of rows) {
    const value = valuations.get(row.id) ?? null;
    out.set(row.id, { value, sort: value });
  }
  return out;
};

export const inventoryDerivedComputes = {
  "inventory.valuation": inventoryValuationCompute,
};
