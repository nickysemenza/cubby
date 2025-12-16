import { z } from 'zod';

// Product source enum
export const productSourceSchema = z.enum(['upcitemdb']);
export type ProductSource = z.infer<typeof productSourceSchema>;

// Successful lookup response
// Note: priceDollars is always in USD
export const productLookupResponseSchema = z.object({
  upc: z.string(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  priceDollars: z.number().nullable(),
  imageUrl: z.string().nullable(),
  source: productSourceSchema,
  cached: z.boolean(),
});
export type ProductLookupResponse = z.infer<typeof productLookupResponseSchema>;

// Aliases for external consumers (more descriptive names)
export const upcLookupResponseSchema = productLookupResponseSchema;
export type UPCLookupResponse = ProductLookupResponse;

// Not found response
export const productNotFoundResponseSchema = z.object({
  found: z.literal(false),
  upc: z.string(),
});
export type ProductNotFoundResponse = z.infer<
  typeof productNotFoundResponseSchema
>;

// Alias for external consumers
export const upcLookupNotFoundSchema = productNotFoundResponseSchema;
export type UPCLookupNotFound = ProductNotFoundResponse;

// Search response
export const searchResponseSchema = z.object({
  products: z.array(productLookupResponseSchema.omit({ cached: true })),
  total: z.number(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// Stats response
export const statsResponseSchema = z.object({
  totalProducts: z.number(),
  bySource: z.object({
    upcitemdb: z.number(),
  }),
  storageUsed: z.object({
    d1Rows: z.number(),
    r2Objects: z.number(),
  }),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

// Error response
export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
