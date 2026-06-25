import { z } from "zod";
import { getDashboardEntityCounts } from "~/server/repo/dashboard";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const dashboardCountsSchema = z.object({
  products: z.number().int(),
  recipes: z.number().int(),
  ingredients: z.number().int(),
  locations: z.number().int(),
  inventory: z.number().int(),
  images: z.number().int(),
  usdaFoods: z.number().int(),
});

/**
 * One call powering the homepage stat cards. The six DB totals are cheap
 * parallel COUNT(*)s (no list fetch, no enrichment); the USDA total comes from
 * the usda-api `/counts` manifest (a single read), NOT a `usda.list` whose
 * service layer would fire a discarded per-food USDA enrichment. Replaces the
 * seven `*.list({pageSize:1})` cards that each fetched + (for product/ingredient
 * /usda) enriched a row just to read `meta.totalCount`.
 */
const counts = protectedProcedure
  .output(dashboardCountsSchema)
  .query(async ({ ctx }) => {
    const [entityCounts, usdaCounts] = await Promise.all([
      getDashboardEntityCounts(ctx.db),
      ctx.usdaClient.getCounts(),
    ]);
    return { ...entityCounts, usdaFoods: usdaCounts?.usda_food ?? 0 };
  });

export const dashboardRouter = createTRPCRouter({ counts });
