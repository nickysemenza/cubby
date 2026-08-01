import { z } from "zod";

export const externalIdKind = z.enum([
  "asin",
  "retailer_sku",
  "internet_number",
  "item_number",
  "catalog_number",
  "legacy_unspecified",
]);
export type ExternalIdKind = z.infer<typeof externalIdKind>;

export const externalIdInput = z.object({
  id: z.uuid().optional(),
  source: z
    .string()
    .min(1)
    .describe("Source identifier (e.g. 'amazon', 'mcmaster', 'mouser')"),
  kind: externalIdKind,
  externalId: z
    .string()
    .min(1)
    .describe("The actual identifier (ASIN, part number, etc.)"),
  url: z
    .string()
    .url()
    .nullish()
    .describe("Optional direct link to the product page"),
});

export type ExternalIdInput = z.infer<typeof externalIdInput>;

export const externalIdOut = z.object({
  id: z.uuid(),
  source: z
    .string()
    .min(1)
    .describe("Source identifier (e.g. 'amazon', 'mcmaster', 'mouser')"),
  kind: externalIdKind,
  externalId: z
    .string()
    .min(1)
    .describe("The actual identifier (ASIN, part number, etc.)"),
  url: z
    .string()
    .url()
    .nullish()
    .describe("Optional direct link to the product page"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ExternalIdOut = z.infer<typeof externalIdOut>;
