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
