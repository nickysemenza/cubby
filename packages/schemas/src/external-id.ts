import { z } from "zod";
import { dbTimestampsOut } from "./common";

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

export const externalIdOut = z
  .object({
    id: z.uuid(),
  })
  .extend(externalIdInput.omit({ id: true }).shape)
  .extend(dbTimestampsOut.shape);

export type ExternalIdInput = z.infer<typeof externalIdInput>;
export type ExternalIdOut = z.infer<typeof externalIdOut>;
