/** Private tool-report inputs; public report leaves select canonical field envelopes. */
import { z } from "zod";
import { inventoryPlacementValues, locationTypeValues } from "@cubby/shared";
import { amount } from "./codec";
import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifier-fields";

export const rawToolProductIdentity = z.object({
  productId: productShortcode,
  productName: z.string(),
  brandName: z.string().nullable(),
});
export const rawToolGalleryInventoryEntry = z.object({
  id: inventoryShortcode,
  amount,
  placement: z.enum(inventoryPlacementValues),
  location: z.object({
    id: locationShortcode,
    name: z.string(),
    ancestors: z.array(
      z.object({
        id: locationShortcode,
        name: z.string(),
        type: z.enum(locationTypeValues).nullable(),
      }),
    ),
  }),
});
export type RawToolGalleryInventoryEntry = z.output<
  typeof rawToolGalleryInventoryEntry
>;
