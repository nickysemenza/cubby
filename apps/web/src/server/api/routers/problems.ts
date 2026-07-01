import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  cleanupOrphanedEntityEmbeddingsInput,
  cleanupOrphanedEntityEmbeddingsOut,
  deleteUnusedIngredientsInput,
  deleteUnusedIngredientsOut,
  dryRunPruneAliasesOut,
  dryRunReparseOut,
  ignoredProblemsOut,
  ignoreProblemInput,
  maintenanceCountsSchema,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsUpcSchema,
  recipeUsageByProductInput,
  recipeUsageByProductOut,
  reparseStaleSyncOut,
  unignoreProblemInput,
} from "@cubby/schemas/problems";
import { streamProgress } from "~/lib/bulk-progress";
import {
  ignoreProblem,
  listIgnoredProblems,
  recipeUsageCountsByProduct,
  unignoreProblem,
} from "~/server/repo/problems";
import {
  cleanupOrphanedEntityEmbeddings,
  deleteUnusedIngredients,
  dryRunPruneAliases,
  dryRunReparse,
  findCoverageProblems,
  findFastProblems,
  findMaintenanceCounts,
  findUpcProblems,
  pruneAllUnusedAliases,
  reparseStaleIngredientParses,
} from "~/server/services/problems.service";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// The Problems surfaces (page, navbar badge, homepage card) all load these three
// cost-grouped procedures and assemble the combined result client-side — each
// over an UNBATCHED link so it gets its own Worker invocation / CPU budget. The
// old monolithic getAllProblems ran every detector in ONE invocation and exceeded
// the 30s CPU limit; it was removed. The two WASM parse-sweeps that re-parse every
// recipe line (stale parses, unused aliases) used to be two more groups here but
// blew the CPU/memory budget on the request path — they're now manual dry-run /
// fix-all actions in Settings → Maintenance (see below). MCP composes these three
// the same way (assembleAllProblems).

// Group: DB-only detectors (cheap).
const getFast = protectedProcedure
  .output(problemsFastSchema)
  .query(async ({ ctx }) => findFastProblems(ctx.db));

// Group: USDA-coverage (one shared product scan + enrichment).
// No `.input()` — takes no argument; the `input={"json":null,...}` superjson
// payload seen in request logs is just the absent (undefined) arg, not a bug.
const getCoverage = protectedProcedure
  .output(problemsCoverageSchema)
  .query(async ({ ctx }) => findCoverageProblems(ctx.db, ctx.usdaClient));

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
    // After the parses land, recompute the affected recipes' totals — off the
    // request path when the set is large (a sweep can touch many recipes).
    await ctx.services.recipeCosting.dispatchRecompute(r.recipesAffected, {
      source: "problems.resolveUnparsedRecipeLine",
    });
    return { updated: r.updated, recipesAffected: r.recipesAffected.length };
  });
});

// Non-streaming twin of {@link reparseStale} for MCP/agent callers (no progress
// stream). Re-parse every stale line, then DISPATCH the affected recipes'
// recompute off the request path (queue in prod) so a big sweep can't overrun the
// Workers budget. This is the agent's mis-merge recovery primitive: once a merge
// folds the right alias onto the surviving ingredient, a re-parse re-points every
// line whose `rawLine` now resolves (via alias match) to the correct ingredient.
const reparseStaleSync = protectedProcedure
  .output(reparseStaleSyncOut)
  .mutation(async ({ ctx }) => {
    const gen = reparseStaleIngredientParses(ctx.db);
    let result: { updated: number; recipesAffected: RecipeId[] } = {
      updated: 0,
      recipesAffected: [],
    };
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
    }
    await ctx.services.recipeCosting.dispatchRecompute(result.recipesAffected, {
      source: "problems.resolveIncorrectIngredientClassifications",
    });
    return {
      updated: result.updated,
      recipesAffected: result.recipesAffected.length,
    };
  });

// On-demand dry run behind the Settings → Maintenance "Re-parse recipe lines"
// button (the WASM sweep is too expensive for an always-on count).
const dryRunReparseProc = protectedProcedure
  .output(dryRunReparseOut)
  .query(async ({ ctx }) => dryRunReparse(ctx.db));

// On-demand dry run behind the Settings → Maintenance "Prune unused aliases"
// button.
const dryRunPruneAliasesProc = protectedProcedure
  .output(dryRunPruneAliasesOut)
  .query(async ({ ctx }) => dryRunPruneAliases(ctx.db));

// Fix-all for unused aliases: detect + strip every ingredient's unused aliases in
// one streamed pass (replaces the old per-alias picker on the Problems page).
const pruneAllUnusedAliasesStream = protectedProcedure.mutation(
  async function* ({ ctx }) {
    yield* streamProgress(pruneAllUnusedAliases(ctx.db), async (r) => r);
  },
);

// Batch: distinct non-deleted recipe count per product (via its ingredient).
// Powers the "used in N recipes" signal on product problem cards. Only
// ingredient-linked products are returned; absence ⇒ no ingredient link.
const recipeUsageByProduct = protectedProcedure
  .input(recipeUsageByProductInput)
  .output(recipeUsageByProductOut)
  .query(async ({ ctx, input }) => {
    return await recipeUsageCountsByProduct(ctx.db, input.productIds);
  });

// Delete entirely-unused ingredients (per-card or bulk). `alsoDeleteProducts`
// distinguishes the two unused-ingredient sections: the product-linked one
// removes the linked products too. Failures (e.g. a product still has inventory)
// are returned per ingredient rather than aborting the batch.
const deleteUnused = protectedProcedure
  .input(deleteUnusedIngredientsInput)
  .output(deleteUnusedIngredientsOut)
  .mutation(async ({ ctx, input }) => {
    return await deleteUnusedIngredients(
      ctx.db,
      input.ingredientIds,
      input.alsoDeleteProducts,
      ctx.actorContext,
    );
  });

const cleanupOrphanedEmbeddings = protectedProcedure
  .input(cleanupOrphanedEntityEmbeddingsInput)
  .output(cleanupOrphanedEntityEmbeddingsOut)
  .mutation(async ({ ctx, input }) => {
    return await cleanupOrphanedEntityEmbeddings(ctx.db, input?.ids);
  });

// Ignore ("keep it") a consciously-accepted problem so it stops re-appearing.
// Keyed by `${sectionId}:${itemId}`; the detector groups exclude it (and the
// badge count, which derives from the same cost-grouped queries, updates for
// free once the problems.* cache invalidates).
const ignore = protectedProcedure
  .input(ignoreProblemInput)
  .mutation(async ({ ctx, input }) => {
    await ignoreProblem(ctx.db, input.sectionId, input.itemId);
    return { success: true };
  });

const unignore = protectedProcedure
  .input(unignoreProblemInput)
  .mutation(async ({ ctx, input }) => {
    await unignoreProblem(ctx.db, input.key);
    return { success: true };
  });

// The ignored list for the "Ignored (N)" un-ignore affordance.
const listIgnored = protectedProcedure
  .output(ignoredProblemsOut)
  .query(async ({ ctx }) => listIgnoredProblems(ctx.db));

export const problemsRouter = createTRPCRouter({
  getFast,
  getCoverage,
  getUpc,
  ignore,
  unignore,
  listIgnored,
  getMaintenanceCounts,
  reparseStale,
  reparseStaleSync,
  dryRunReparse: dryRunReparseProc,
  dryRunPruneAliases: dryRunPruneAliasesProc,
  pruneAllUnusedAliasesStream,
  recipeUsageByProduct,
  deleteUnused,
  cleanupOrphanedEmbeddings,
});
