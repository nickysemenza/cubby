import { upc } from "@cubby/usda-schemas";
import { z } from "zod";

export const upcLookupInput = z.object({
  upc,
});

export const upcSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(100).default(20),
});

export type UpcLookupInput = z.infer<typeof upcLookupInput>;
export type UpcSearchInput = z.infer<typeof upcSearchInput>;
