import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { uniq } from "es-toolkit";

const NO_INVENTORY_ITEMS: InventoryItemForTree[] = [];

export type LocationInventoryIndex = Map<string, InventoryItemForTree[]>;

/**
 * Every distinct product referenced anywhere in a `location.makeTree` forest —
 * the id list `ProductImageSummariesProvider` needs to hydrate covers. Shared by
 * the gallery and the arrange surface so both derive the same set from the same
 * query; `useChunkedRecordQuery` sorts before chunking, so they hit identical
 * cache entries rather than refetching per page.
 */
export function collectTreeProductIds(locations: InfLocation[]): string[] {
  const productIds: string[] = [];

  const visit = (nodes: InfLocation[]) => {
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

  const visit = (nodes: InfLocation[]) => {
    for (const location of nodes) {
      inventoryByLocation.set(
        location.id,
        location.inventoryItems ?? NO_INVENTORY_ITEMS,
      );
      if (location.children) visit(location.children);
    }
  };

  visit(locations);
  return {
    inventoryByLocation,
    productIds: collectTreeProductIds(locations),
  };
}
