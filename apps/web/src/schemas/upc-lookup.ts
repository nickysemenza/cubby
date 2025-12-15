import { z } from "zod";

export const upcLookupResponseSchema = z.object({
  upc: z.string(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  priceDollars: z.number().nullable(),
  imageUrl: z.string().nullable(),
  source: z.enum(["upcitemdb", "openfoodfacts"]),
  cached: z.boolean(),
});

export type UPCLookupResponse = z.infer<typeof upcLookupResponseSchema>;

export const upcLookupNotFoundSchema = z.object({
  found: z.literal(false),
  upc: z.string(),
});

export type UPCLookupNotFound = z.infer<typeof upcLookupNotFoundSchema>;
