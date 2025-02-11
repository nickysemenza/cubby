import { z } from "zod";
import { dbTimestampsOut } from "./util";

export const productBase = z.object({
  name: z.string(),
  upc: z.string().length(12).nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
});

export const productTopLevelOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(productBase)
  .merge(dbTimestampsOut);
