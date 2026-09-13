import { z } from "zod";

export const dashboardCountsOut = z.object({
  product: z.number().int(),
  recipe: z.number().int(),
  ingredient: z.number().int(),
  cookbook: z.number().int(),
  location: z.number().int(),
  inventory: z.number().int(),
  meal: z.number().int(),
  project: z.number().int(),
  task: z.number().int(),
  vendor: z.number().int(),
  purchase: z.number().int(),
  expense: z.number().int(),
  financialAccount: z.number().int(),
  financialTransaction: z.number().int(),
  image: z.number().int(),
  wish: z.number().int(),
  planting: z.number().int(),
  gardenEntry: z.number().int(),
  usdaFoods: z.number().int(),
});

export type DashboardCountsOut = z.infer<typeof dashboardCountsOut>;
