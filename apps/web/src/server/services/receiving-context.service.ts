import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  inventoryReceivingContextInput,
  InventoryReceivingContextOut,
} from "@cubby/schemas/inventory";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getProductExpectedQuantity,
  listProductStock,
} from "~/server/repo/inventory/product-stock";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  getProductMatchQueue,
  type ProductMatchDependencies,
} from "./product-match.service";
import { deriveReceivingGuidance } from "./receiving-guidance";

/**
 * Read-only: what already counts for a Product before an Expense is received.
 * Reuses the focused Product match read (one vector lookup, dismissed pairs
 * excluded) so a photo-created stocked Product that may be the same item
 * surfaces before the operator adds units. Never writes stock.
 */
export async function getReceivingContext(
  db: Database,
  input: z.output<typeof inventoryReceivingContextInput>,
  deps?: ProductMatchDependencies,
): Promise<InventoryReceivingContextOut> {
  const productId = await resolveOrThrow(db, "product", input.productId);
  const [stockRows, queue, expectedQuantity] = await Promise.all([
    listProductStock(db, productId),
    getProductMatchQueue(db, { productId: input.productId }, deps),
    getProductExpectedQuantity(db, productId),
  ]);
  const stock = stockRows.map((row) => ({
    id: parseShortcodeFor("inventory", row.shortcode),
    locationId: parseShortcodeFor("location", row.locationShortcode),
    locationName: row.locationName,
    amount: { value: row.value, unit: row.unit },
  }));
  const matches = queue.items.flatMap((item) => {
    const candidate = [item.keeper, item.other].find(
      (side) => side.id !== input.productId,
    );
    return candidate
      ? [
          {
            source: item.source,
            evidence: item.evidence,
            candidate,
            warnings: item.warnings,
          },
        ]
      : [];
  });
  return {
    productId: input.productId,
    stock,
    matches,
    ...deriveReceivingGuidance({
      expectedQuantity,
      stock,
      matches: matches.map((match) => match.candidate),
    }),
  };
}
