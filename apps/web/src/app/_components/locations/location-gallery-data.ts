import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { uniq } from "es-toolkit";

const NO_INVENTORY_ITEMS: InventoryItemForTree[] = [];

export type LocationInventoryIndex = Map<string, InventoryItemForTree[]>;

/**
 * Derive every gallery lookup from `location.makeTree`. The tree already owns
 * the minimal product projection the gallery needs, so this keeps the default
 * Locations page independent of the paginated `inventory.list` endpoint.
 */
export function buildLocationGalleryData(locations: InfLocation[]): {
  inventoryByLocation: LocationInventoryIndex;
  productIds: string[];
} {
  const inventoryByLocation: LocationInventoryIndex = new Map();
  const productIds: string[] = [];

  const visit = (nodes: InfLocation[]) => {
    for (const location of nodes) {
      const items = location.inventoryItems ?? NO_INVENTORY_ITEMS;
      inventoryByLocation.set(location.id, items);
      for (const item of items) productIds.push(item.productId);
      if (location.children) visit(location.children);
    }
  };

  visit(locations);
  return { inventoryByLocation, productIds: uniq(productIds) };
}
