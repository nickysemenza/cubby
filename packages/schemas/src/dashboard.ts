import { z } from "zod";

export const dashboardCountsOut = z.object({
  products: z.number().int(),
  recipes: z.number().int(),
  ingredients: z.number().int(),
  locations: z.number().int(),
  inventory: z.number().int(),
  images: z.number().int(),
  usdaFoods: z.number().int(),
});

export type DashboardCountsOut = z.infer<typeof dashboardCountsOut>;
