import type {
  LocationTreeNode,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { uniq } from "es-toolkit";

const NO_INVENTORY_ITEMS: InventoryItemForTree[] = [];

/**
 * Every distinct product referenced anywhere in a `location.makeTree` forest —
 * the id list the canonical display-image provider needs to resolve identities.
 * The selected-place browser hydrates only its disclosed contents instead.
 */
export function collectTreeProductIds(locations: LocationTreeNode[]): string[] {
  const productIds: string[] = [];

  const visit = (nodes: LocationTreeNode[]) => {
    for (const location of nodes) {
      for (const item of location.inventoryItems ?? NO_INVENTORY_ITEMS) {
        productIds.push(item.productId);
      }
      if (location.children) visit(location.children);
    }
  };

  visit(locations);
  return uniq(productIds);
}
