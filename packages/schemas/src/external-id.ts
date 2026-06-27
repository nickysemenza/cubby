import { z } from "zod";

export const externalIdInput = z.object({
  id: z.uuid().optional(),
  source: z
    .string()
    .min(1)
    .describe("Source identifier (e.g. 'amazon', 'mcmaster', 'mouser')"),
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
