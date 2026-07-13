import { upc } from "@cubby/usda-schemas";
import { z } from "zod";

export const upcLookupInput = z.object({ upc });
export const upcSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(100).default(20),
});
export type UpcLookupInput = z.infer<typeof upcLookupInput>;
export type UpcSearchInput = z.infer<typeof upcSearchInput>;

export const UPC_SOURCE_NAMES = ["manual", "upcitemdb"] as const;
export const productSourceSchema = z.enum(UPC_SOURCE_NAMES);
export type UpcProductSource = z.infer<typeof productSourceSchema>;
export type ExternalUpcProductSource = Exclude<UpcProductSource, "manual">;

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

export const productLookupPublicResponseSchema = z.object(
  productLookupPublicFields,
);
export type ProductLookupPublicResponse = z.infer<
  typeof productLookupPublicResponseSchema
>;
export const productLookupResponseSchema = z.object({
  ...productLookupPublicFields,
  cached: z.boolean(),
});
export type ProductLookupResponse = z.infer<typeof productLookupResponseSchema>;
export const upcLookupResponseSchema = productLookupResponseSchema;
export type UPCLookupResponse = ProductLookupResponse;

export const productNotFoundResponseSchema = z.object({
  found: z.literal(false),
  upc: z.string(),
});
export type ProductNotFoundResponse = z.infer<
  typeof productNotFoundResponseSchema
>;
export const upcLookupNotFoundSchema = productNotFoundResponseSchema;
export type UPCLookupNotFound = ProductNotFoundResponse;

export const searchResponseSchema = z.object({
  products: z.array(productLookupPublicResponseSchema),
  total: z.number(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export const bulkLookupRequestSchema = z.object({
  upcs: z.array(z.string()).min(1).max(200),
});
export type BulkLookupRequest = z.infer<typeof bulkLookupRequestSchema>;
export const bulkLookupResponseSchema = z.object({
  products: z.array(productLookupPublicResponseSchema),
  pending: z.number(),
});
export type BulkLookupResponse = z.infer<typeof bulkLookupResponseSchema>;

export const statsResponseSchema = z.object({
  totalProducts: z.number(),
  bySource: z.record(z.string(), z.number()),
  storageUsed: z.object({
    d1Rows: z.number(),
    r2Objects: z.number(),
  }),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;
export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
