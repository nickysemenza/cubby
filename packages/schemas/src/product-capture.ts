import { z } from "zod";

import {
  inventoryCreatePayloadData,
  inventoryPlacement,
  inventoryWithLocationAndProductOut,
} from "./inventory";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { productCreateInput, productWithFoodOut } from "./product";

export const productCreateWithInventoryInput = z.object({
  product: productCreateInput,
  // The normal Inventory create validator still runs inside the command;
  // this projection removes its Product id and requires reviewed placement.
  inventory: z
    .object(inventoryCreatePayloadData.shape)
    .omit({ productId: true })
    .extend({ placement: inventoryPlacement }),
});
export type ProductCreateWithInventoryInput = z.infer<
  typeof productCreateWithInventoryInput
>;

export const productCreateWithInventoryOut = z.object({
  product: productWithFoodOut,
  inventory: inventoryWithLocationAndProductOut,
  sideEffects: mutationSideEffectsSchema,
});
export type ProductCreateWithInventoryOut = z.infer<
  typeof productCreateWithInventoryOut
>;
