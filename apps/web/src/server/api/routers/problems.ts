import { type RecipeId, unsafeIngredientId } from "@cubby/schemas/identifiers";
import {
  cleanupOrphanedEntityEmbeddingsInput,
  cleanupOrphanedEntityEmbeddingsOut,
  coverageTotalsSchema,
  deleteUnusedIngredientsInput,
  deleteUnusedIngredientsOut,
  dryRunPruneAliasesOut,
  dryRunReparseOut,
  maintenanceCountsSchema,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsTrackerSchema,
  problemsUpcSchema,
  recipeUsageByProductInput,
  recipeUsageByProductOut,
  reparseStaleSyncOut,
} from "@cubby/schemas/problems";
import { streamProgress } from "~/lib/bulk-progress";
import { createAppError } from "~/server/errors/app-error";
import { recipeUsageCountsByProduct } from "~/server/repo/problems";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import {
  cleanupOrphanedEntityEmbeddings,
  deleteUnusedIngredients,
  dryRunPruneAliases,
  dryRunReparse,
  findCoverageProblems,
  findCoverageTotals,
  findFastProblems,
  findMaintenanceCounts,
  findTrackerProblems,
  findUpcProblems,
  pruneAllUnusedAliases,
  reparseStaleIngredientParses,
} from "~/server/services/problems.service";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

// The Problems surfaces (page, navbar badge, homepage card) all load these four
// cost-grouped procedures and assemble the combined result client-side — each
// over an UNBATCHED link so it gets its own Worker invocation / CPU budget. The
// old monolithic getAllProblems ran every detector in ONE invocation and exceeded
// the 30s CPU limit; it was removed. The two WASM parse-sweeps that re-parse every
// recipe line (stale parses, unused aliases) used to be two more groups here but
// blew the CPU/memory budget on the request path — they're now manual dry-run /
// fix-all actions in Settings → Maintenance (see below). MCP composes these four
// the same way (assembleAllProblems).

// Group: DB-only detectors (cheap).
const getFast = protectedProcedure
  .output(strictOutput(problemsFastSchema))
  .query(async ({ ctx }) => findFastProblems(ctx.db));

// Group: USDA-coverage (one shared product scan + enrichment).
// No `.input()` — takes no argument; the `input={"json":null,...}` superjson
// payload seen in request logs is just the absent (undefined) arg, not a bug.
const getCoverage = protectedProcedure
  .output(strictOutput(problemsCoverageSchema))
  .query(async ({ ctx }) => findCoverageProblems(ctx.db, ctx.usdaClient));

// Group: better-UPC network detector.
const getUpc = protectedProcedure
  .output(strictOutput(problemsUpcSchema))
  .query(async ({ ctx }) => findUpcProblems(ctx.db, ctx.upcLookupClient));

// Group: household-tracker attention rules (projects/tasks/expenses). Cheap
// aggregate SQL, but its own group so it runs concurrently with — rather than
// serialized behind — the fast group's pinned single connection.
const getTracker = protectedProcedure
  .output(strictOutput(problemsTrackerSchema))
  .query(async ({ ctx }) => findTrackerProblems(ctx.db));

// Population denominators for the Problems page's coverage meters. Cheap
// count(*)s, and page-only — so unlike the four groups above it stays on the
// BATCHED link (it is absent from PROBLEMS_HOT_PATH_PROCEDURES on purpose).
const getCoverageTotals = protectedProcedure
  .output(strictOutput(coverageTotalsSchema))
  .query(async ({ ctx }) => findCoverageTotals(ctx.db));

// Counts behind the Settings → Maintenance "N affected" dry-run. Focused subset
// of detectors (no USDA/UPC network); badge/count consumers instead derive
// counts client-side from the five cost-grouped queries via countProblems.
const getMaintenanceCounts = protectedProcedure
  .output(strictOutput(maintenanceCountsSchema))
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
      source: "problems.reparseStale",
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
  .output(strictOutput(reparseStaleSyncOut))
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
      source: "problems.reparseStaleSync",
    });
    return {
      updated: result.updated,
      recipesAffected: result.recipesAffected.length,
    };
  });

// On-demand dry run behind the Settings → Maintenance "Re-parse recipe lines"
// button (the WASM sweep is too expensive for an always-on count).
const dryRunReparseProc = protectedProcedure
  .output(strictOutput(dryRunReparseOut))
  .query(async ({ ctx }) => dryRunReparse(ctx.db));

// On-demand dry run behind the Settings → Maintenance "Prune unused aliases"
// button.
const dryRunPruneAliasesProc = protectedProcedure
  .output(strictOutput(dryRunPruneAliasesOut))
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
  .output(strictOutput(recipeUsageByProductOut))
  .query(async ({ ctx, input }) => {
    return await recipeUsageCountsByProduct(ctx.db, input.productShortcodes);
  });

// Delete entirely-unused ingredients (per-card or bulk). `alsoDeleteProducts`
// distinguishes the two unused-ingredient sections: the product-linked one
// removes the linked products too. Failures (e.g. a product still has inventory)
// are returned per ingredient rather than aborting the batch.
const deleteUnused = protectedProcedure
  .input(deleteUnusedIngredientsInput)
  .output(strictOutput(deleteUnusedIngredientsOut))
  .mutation(async ({ ctx, input }) => {
    const resolved = await resolveLiveShortcodes(
      ctx.db,
      input.ingredientIds,
      "ingredient",
    );
    const missing = input.ingredientIds.find((id) => !resolved.has(id));
    if (missing) {
      throw createAppError(
        "INGREDIENT_NOT_FOUND",
        `Ingredient ${missing} not found`,
      );
    }
    const entityIds = input.ingredientIds.map((id) =>
      unsafeIngredientId(resolved.get(id)!),
    );
    const result = await deleteUnusedIngredients(
      ctx.db,
      entityIds,
      input.alsoDeleteProducts,
      ctx.actorContext,
    );
    const shortcodeByEntityId = new Map(
      input.ingredientIds.map((shortcode, index) => [
        entityIds[index],
        shortcode,
      ]),
    );
    return {
      deleted: result.deleted,
      failed: result.failed.map(({ id, reason }) => ({
        id: shortcodeByEntityId.get(id)!,
        reason,
      })),
    };
  });

const cleanupOrphanedEmbeddings = protectedProcedure
  .input(cleanupOrphanedEntityEmbeddingsInput)
  .output(strictOutput(cleanupOrphanedEntityEmbeddingsOut))
  .mutation(async ({ ctx, input }) => {
    return await cleanupOrphanedEntityEmbeddings(ctx.db, input?.ids);
  });

export const problemsRouter = createTRPCRouter({
  getFast,
  getCoverage,
  getUpc,
  getTracker,
  getCoverageTotals,
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
