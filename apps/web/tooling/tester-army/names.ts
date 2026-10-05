import {
  SIM_PRODUCT_NAME,
  SIM_PRODUCT_UPDATED_NAME,
} from "../scenarios/simulator-product-fixture";

/** Synthetic names shared by the seed and the journeys' exact assertions. */
export const JOURNEY_NAMES = {
  productName: SIM_PRODUCT_NAME,
  productUpdatedName: SIM_PRODUCT_UPDATED_NAME,
  receiveShelf: "Synthetic Receiving Shelf",
  inventoryShelf: "Synthetic Inventory Shelf",
  boardProjectA: "Synthetic Board Project A",
  boardProjectB: "Synthetic Board Project B",
} as const;

/**
 * Synthetic sources the coupled journeys import through the live agent. The
 * account-sync order id is unhyphenated: the order-history classifier only
 * reads `[A-Z0-9]{6,20}` after an "Order" label.
 */
export const LIVE_IMPORT = {
  mail: {
    vendor: "Synthetic Seed Supply",
    orderId: "SYN-CONFIRM-LIVE-1",
    // Variant-specific, so a new Product is a safe identity. A bare "Herb
    // packet" correctly stopped the live coordinator for review.
    item: "Synthetic Seed Supply Genovese basil seed packet, 1 g",
    cents: 500,
  },
  sync: {
    vendor: "Synthetic Trowel Works",
    host: "shop.example.test",
    orderId: "SYNSYNC01",
    item: "Synthetic garden trowel",
    cents: 1_500,
  },
  // JPEG: cloud description requires a JPEG rendition, and local storage
  // serves `/cdn-cgi/image/` as the original bytes.
  photos: ["synthetic-wardrobe-shirt.jpg", "synthetic-wardrobe-boots.jpg"],
} as const;
