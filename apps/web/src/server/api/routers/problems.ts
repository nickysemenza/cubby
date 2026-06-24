import { ingredientId } from "@cubby/schemas/identifiers";
import {
  allProblemsSchema,
  maintenanceCountsSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";
import { streamProgress } from "~/lib/bulk-progress";
import {
  deleteUnusedIngredients,
  findAllProblems,
  findMaintenanceCounts,
  pruneUnusedAliases,
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

// Counts behind the Settings → Maintenance "N affected" dry-run. Focused subset
// of detectors (no USDA/UPC network); badge/count consumers instead derive
// counts client-side from getAllProblems via countProblems (one shared scan).
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

// Strip "unused" aliases from one or more ingredients (per-card removes one, the
// section's bulk button removes all). The ingredient itself is never deleted.
const pruneAliases = protectedProcedure
  .input(
    z.object({
      items: z.array(z.object({ ingredientId, remove: z.array(z.string()) })),
    }),
  )
  .output(z.object({ pruned: z.number() }))
  .mutation(async ({ ctx, input }) => {
    return await pruneUnusedAliases(ctx.db, input.items);
  });

// Delete entirely-unused ingredients (per-card or bulk). `alsoDeleteProducts`
// distinguishes the two unused-ingredient sections: the product-linked one
// removes the linked products too. Failures (e.g. a product still has inventory)
// are returned per ingredient rather than aborting the batch.
const deleteUnused = protectedProcedure
  .input(
    z.object({
      ingredientIds: z.array(ingredientId),
      alsoDeleteProducts: z.boolean(),
    }),
  )
  .output(
    z.object({
      deleted: z.number(),
      failed: z.array(z.object({ id: ingredientId, reason: z.string() })),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return await deleteUnusedIngredients(
      ctx.db,
      input.ingredientIds,
      input.alsoDeleteProducts,
      ctx.actorContext,
    );
  });

export const problemsRouter = createTRPCRouter({
  getAllProblems,
  getMaintenanceCounts,
  reparseStale,
  recipeUsageByProduct,
  pruneAliases,
  deleteUnused,
});
