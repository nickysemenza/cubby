import { dashboardCountsOut } from "@cubby/schemas/dashboard";
import { getEntityCounts } from "~/server/repo/dashboard";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

/**
 * One call powering the homepage stat cards. The local totals come from one
 * cheap scalar-subquery read (no list fetch, no enrichment); USDA comes from
 * the usda-api `/counts` manifest (a single read), NOT a `usda.list` whose
 * service layer would fire a discarded per-food USDA enrichment. Replaces the
 * seven `*.list({pageSize:1})` cards that each fetched + (for product/ingredient
 * /usda) enriched a row just to read `meta.totalCount`.
 */
const counts = protectedProcedure
  .output(strictOutput(dashboardCountsOut))
  .query(async ({ ctx }) => {
    const [entityCounts, usdaCounts] = await Promise.all([
      getEntityCounts(ctx.db),
      // The USDA total is ancillary on most pages (footer/home card). Keep the
      // local entity totals usable when the bound worker is unavailable in dev,
      // CI, or a transient deploy window.
      ctx.usdaClient.getCounts().catch((error) => {
        console.warn(
          "[dashboard.counts] USDA count unavailable; using 0",
          error,
        );
        return null;
      }),
    ]);
    return { ...entityCounts, usdaFoods: usdaCounts?.usda_food ?? 0 };
  });

export const dashboardRouter = createTRPCRouter({ counts });
