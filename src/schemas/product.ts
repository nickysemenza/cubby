import { z } from "zod";
import { dbTimestamps } from "~/schemas/util";

export const productBase = z.object({
  name: z.string(),
  upc: z.string().length(12),
  manufacturer: z.string(),
  model: z.string().nullable(),
});

export const productTopLevel = z
  .object({
    id: z.string().uuid(),
  })
  .merge(productBase)
  .merge(dbTimestamps);

export const productWithItem = productTopLevel.merge(
  z.object({
    item: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
      })
      .nullable(),
  }),
);
