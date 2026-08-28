import type { InventoryShortcode } from "@cubby/schemas/identifiers";
import type { placementRecommendationOut } from "@cubby/schemas/recommendations";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  getInventoryEntryByShortcode,
  getProductStockRows,
} from "~/server/repo/inventory";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

type PlacementRecommendation = z.infer<typeof placementRecommendationOut>;

/**
 * A parked row earns a destination only when its exact Product already has one
 * other live stock location. Ambiguous filing stays in Problems as a prompt;
 * this never labels an unproven location as a stray or moves automatically.
 */
export async function getPlacementRecommendation(
  db: Database,
  inventoryId: InventoryShortcode,
): Promise<PlacementRecommendation> {
  const source = await getInventoryEntryByShortcode(db, inventoryId);
  if (!source) return null;
  if (source.placement !== "stock" || source.location.name !== "Unknown")
    return null;
  const productId = await resolveOrThrow(db, "product", source.product.id);
  const destinations = (await getProductStockRows(db, productId)).filter(
    (row) => row.id !== source.id && row.location.name !== "Unknown",
  );
  if (destinations.length !== 1) return null;
  const destination = destinations[0]!;
  return {
    inventoryId: source.id,
    productName: source.product.name,
    sourceLocation: { id: source.location.id, name: source.location.name },
    destination: {
      id: destination.location.id,
      name: destination.location.name,
    },
  };
}
