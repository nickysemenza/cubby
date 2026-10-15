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
} from "~/server/domains/inventory/repo/product-stock";
import { getProductMatchQueue } from "~/server/domains/product/service/product-match.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { deriveReceivingGuidance } from "./receiving-guidance";

/**
 * Read-only: what already counts for a Product before an Expense is received.
 * Reuses the focused Product match read (stored assessments, dismissed pairs
 * excluded) so a photo-created stocked Product that may be the same item
 * surfaces before the operator adds units. Never writes stock.
 */
export async function getReceivingContext(
  db: Database,
  input: z.output<typeof inventoryReceivingContextInput>,
): Promise<InventoryReceivingContextOut> {
  const productId = await resolveOrThrow(db, "product", input.productId);
  const [stockRows, queue, expectedQuantity] = await Promise.all([
    listProductStock(db, productId),
    getProductMatchQueue(db, { productId: input.productId }),
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
