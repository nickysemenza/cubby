import {
  allProblemsSchema,
  maintenanceCountsSchema,
  problemsCountSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";
import { streamProgress } from "~/lib/bulk-progress";
import {
  findAllProblems,
  findAllProblemsCount,
  findMaintenanceCounts,
  recipeUsageCountsByProduct,
  reparseStaleIngredientParses,
} from "~/server/repo/problems";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Main procedure to get all problems
const getAllProblems = protectedProcedure
  .output(allProblemsSchema)
  .query(async ({ ctx }) => {
    return await findAllProblems(ctx.db, ctx.upcLookupClient, ctx.usdaClient);
  });

// Count-only procedure for badge display (optimized)
const getProblemsCount = protectedProcedure
  .output(problemsCountSchema)
  .query(async ({ ctx }) => {
    return await findAllProblemsCount(
      ctx.db,
      ctx.upcLookupClient,
      ctx.usdaClient,
    );
  });

// Counts behind the Settings → Maintenance "N affected" dry-run. Focused subset
// of detectors (no USDA/UPC network), separate from getProblemsCount.
const getMaintenanceCounts = protectedProcedure
  .output(maintenanceCountsSchema)
  .query(async ({ ctx }) => {
    return await findMaintenanceCounts(ctx.db);
  });

// Re-parse every stale ingredient line with the current parser and persist the fresh
// result (name, amounts, modifier), then recompute affected recipe totals so the
// costing reflects the updated lines immediately. Clears the Stale Parses section.
const reparseStale = protectedProcedure.mutation(async function* ({ ctx }) {
  yield* streamProgress(reparseStaleIngredientParses(ctx.db), async (r) => {
    // After the parses land, recompute the affected recipes' totals.
    await ctx.services.recipeCosting.recompute(r.recipesAffected);
    return { updated: r.updated, recipesAffected: r.recipesAffected.length };
  });
});

// Batch: distinct non-deleted recipe count per product (via its ingredient).
// Powers the "used in N recipes" signal on product problem cards. Only
// ingredient-linked products are returned; absence ⇒ no ingredient link.
const recipeUsageByProduct = protectedProcedure
  .input(z.object({ productIds: z.array(z.string()) }))
  .output(z.record(z.string(), z.number()))
  .query(async ({ ctx, input }) => {
    return await recipeUsageCountsByProduct(ctx.db, input.productIds);
  });

export const problemsRouter = createTRPCRouter({
  getAllProblems,
  getProblemsCount,
  getMaintenanceCounts,
  reparseStale,
  recipeUsageByProduct,
});
