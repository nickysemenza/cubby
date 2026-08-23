import { z } from "zod";

// Live row counts powering the homepage stat strip, footer, and /entities page.
// Keyed by entity name (the manifest's countable entities) plus the USDA total,
// which comes from the usda-api worker rather than a local table.
export const dashboardCountsOut = z.object({
  product: z.number().int(),
  recipe: z.number().int(),
  ingredient: z.number().int(),
  cookbook: z.number().int(),
  location: z.number().int(),
  inventory: z.number().int(),
  meal: z.number().int(),
  person: z.number().int(),
  project: z.number().int(),
  task: z.number().int(),
  vendor: z.number().int(),
  purchase: z.number().int(),
  expense: z.number().int(),
  financialAccount: z.number().int(),
  financialTransaction: z.number().int(),
  image: z.number().int(),
  wish: z.number().int(),
  usdaFoods: z.number().int(),
});

export type DashboardCountsOut = z.infer<typeof dashboardCountsOut>;
