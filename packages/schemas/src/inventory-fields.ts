import { inventoryPlacementValues } from "@cubby/shared";
import { z } from "zod";
import { moneyNullable } from "./money";

/** Cycle-safe field schemas consumed by the generated Inventory contract. */
export const inventoryPlacement = z.enum(inventoryPlacementValues);

export const inventoryValuation = moneyNullable;
