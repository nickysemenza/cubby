import { z } from "zod";

/** Source-only storage facet shared by declarations and Image association validators. */
export const imageAssociationStorage = z.object({
  product: z.literal("gallery"),
  recipe: z.literal("gallery"),
  location: z.literal("gallery"),
  meal: z.literal("gallery"),
  project: z.literal("gallery"),
  task: z.literal("gallery"),
  purchase: z.literal("gallery"),
  gardenEntry: z.literal("gallery"),
  cookbook: z.literal("cover"),
  vendor: z.literal("logo"),
});
