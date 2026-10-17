import { inventoryPlacementValues } from "@cubby/shared";
import { z } from "zod";
import { moneyNullable } from "./money";

/** Cycle-safe field schemas consumed by the generated Inventory contract. */
export const inventoryPlacement = z.enum(inventoryPlacementValues);

export const inventoryValuation = moneyNullable;
/**
 * A row's valuation state: valued, else whether its product has an effective
 * price the stored unit cannot reach (priceable) or none (unpriceable).
 */
export const inventoryValuationStatus = z.enum([
  "valued",
  "priceable",
  "unpriceable",
]);
