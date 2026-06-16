import {
  allProblemsSchema,
  problemsCountSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";
import {
  findAllProblems,
  findAllProblemsCount,
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

// Re-parse every stale ingredient line with the current parser and persist the fresh
// result (name, amounts, modifier), then recompute affected recipe totals so the
// costing reflects the updated lines immediately. Clears the Stale Parses section.
const reparseStale = protectedProcedure
  .output(
    z.object({
      updated: z.number(),
      recipesAffected: z.number(),
    }),
  )
  .mutation(async ({ ctx }) => {
    const { updated, recipesAffected } = await reparseStaleIngredientParses(
      ctx.db,
    );
    await ctx.services.recipeCosting.recompute(recipesAffected);
    return { updated, recipesAffected: recipesAffected.length };
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
  reparseStale,
  recipeUsageByProduct,
});
