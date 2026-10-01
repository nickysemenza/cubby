import { upc } from "@cubby/shared/upc";
import { z } from "zod";

export const upcLookupInput = z.object({ upc });

/** `manual` rows are hand-entered (imported from the retired lookup Worker). */
const UPC_SOURCE_NAMES = ["manual", "upcitemdb"] as const;
export const productSourceSchema = z.enum(UPC_SOURCE_NAMES);
export type UpcProductSource = z.infer<typeof productSourceSchema>;

const productLookupPublicFields = {
  upc: z.string(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  priceDollars: z.number().nullable(),
  imageUrl: z.string().nullable(),
  source: productSourceSchema,
};

const productLookupPublicResponseSchema = z.object(productLookupPublicFields);
export const productLookupResponseSchema = z.object({
  ...productLookupPublicFields,
  cached: z.boolean(),
});
export type UPCLookupResponse = z.infer<typeof productLookupResponseSchema>;

const searchResponseSchema = z.object({
  products: z.array(productLookupPublicResponseSchema),
  total: z.number(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
