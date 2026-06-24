import { ingredientId } from "@cubby/schemas/identifiers";
import {
  maintenanceCountsSchema,
  problemsAliasesSchema,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsParsesSchema,
  problemsUpcSchema,
} from "@cubby/schemas/problems";
import { z } from "zod";
import { streamProgress } from "~/lib/bulk-progress";
import {
  pruneUnusedAliases,
  recipeUsageCountsByProduct,
} from "~/server/repo/problems";
import {
  deleteUnusedIngredients,
  findAliasesProblems,
  findCoverageProblems,
  findFastProblems,
  findMaintenanceCounts,
  findParsesProblems,
  findUpcProblems,
  reparseStaleIngredientParses,
} from "~/server/services/problems.service";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// The Problems surfaces (page, navbar badge, homepage card) all load these five
// cost-grouped procedures and assemble the combined result client-side — each
// over an UNBATCHED link so it gets its own Worker invocation / CPU budget. The
// old monolithic getAllProblems ran every detector (two re-parse every recipe
// line through WASM) in ONE invocation and exceeded the 30s CPU limit; it was
// removed. MCP composes these five the same way (assembleAllProblems).

// Group: DB-only detectors (cheap).
const getFast = protectedProcedure
  .output(problemsFastSchema)
  .query(async ({ ctx }) => findFastProblems(ctx.db));

// Group: USDA-coverage (one shared product scan + enrichment).
const getCoverage = protectedProcedure
  .output(problemsCoverageSchema)
  .query(async ({ ctx }) => findCoverageProblems(ctx.db, ctx.usdaClient));

// Group: unused-aliases WASM parse-sweep (isolated CPU budget).
const getAliases = protectedProcedure
  .output(problemsAliasesSchema)
  .query(async ({ ctx }) => findAliasesProblems(ctx.db));

// Group: stale-parses WASM parse-sweep (isolated CPU budget).
const getParses = protectedProcedure
  .output(problemsParsesSchema)
  .query(async ({ ctx }) => findParsesProblems(ctx.db));

// Group: better-UPC network detector.
const getUpc = protectedProcedure
  .output(problemsUpcSchema)
  .query(async ({ ctx }) => findUpcProblems(ctx.db, ctx.upcLookupClient));

// Counts behind the Settings → Maintenance "N affected" dry-run. Focused subset
// of detectors (no USDA/UPC network); badge/count consumers instead derive
// counts client-side from the five cost-grouped queries via countProblems.
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
  getFast,
  getCoverage,
  getAliases,
  getParses,
  getUpc,
  getMaintenanceCounts,
  reparseStale,
  recipeUsageByProduct,
  pruneAliases,
  deleteUnused,
});
