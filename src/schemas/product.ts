import { z } from "zod";

export const productBase = z.object({
  name: z.string(),
  upc: z.string().length(12),
  manufacturer: z.string(),
  model: z.string().nullable(),
});
