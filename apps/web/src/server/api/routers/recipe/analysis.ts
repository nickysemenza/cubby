/**
 * Recipe analysis / costing procedures.
 *
 * Ingredient co-occurrence, the recipe dependency graph, ingredient usage,
 * the costing maintenance surface (recompute all / streamed / dry-run /
 * explain), and the on-demand equivalence harvest. Split out of the recipe
 * router god file; paths are re-composed flat in `../recipe.ts`, so client
 * procedure paths are unchanged.
 */

import {
  type CandidateEquivalence,
  type EquivalenceReport,
  equivalenceReportSchema,
} from "@cubby/schemas/equivalences";
import {
  type IngredientCooccurrence,
  ingredientCooccurrenceSchema,
} from "@cubby/schemas/ingredient-cooccurrence";
import {
  type IngredientUsage,
  ingredientUsageSchema,
} from "@cubby/schemas/ingredient-usage";
import {
  recipeCooccurrenceInput,
  recipeCookbookScopeInput,
  recipeDryRunRecomputeTotalsOut,
  recipeIdInput,
  recipeRecomputeAllOut,
} from "@cubby/schemas/recipe";
import {
  type RecipeDependencyGraph,
  recipeDependencyGraphSchema,
} from "@cubby/schemas/recipe-dependency-graph";
import { recipeCostingExplain } from "@cubby/schemas/recipe-shared";
import { uniq } from "es-toolkit";
import { streamProgress } from "~/lib/bulk-progress";
import { harvestEquivalences } from "~/lib/harvest-equivalences";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import { getMultiMeasureRecipeIngredients } from "~/server/repo/equivalences";
import {
  getIngredientCooccurrence,
  getIngredientUsage,
  getRecipeDependencyGraph,
} from "~/server/repo/recipe";
import { protectedProcedure } from "../../trpc";

const getIngredientCooccurrenceEndpoint = protectedProcedure
  .input(recipeCooccurrenceInput)
  .output(ingredientCooccurrenceSchema)
  .query(async ({ ctx, input }): Promise<IngredientCooccurrence> => {
    return await getIngredientCooccurrence(ctx.db, input?.minEdgeWeight ?? 2);
  });

const getDependencyGraphEndpoint = protectedProcedure
  .input(recipeCookbookScopeInput)
  .output(recipeDependencyGraphSchema)
  .query(async ({ ctx, input }): Promise<RecipeDependencyGraph> => {
    return await getRecipeDependencyGraph(ctx.db, input?.cookbookId);
  });

const getIngredientUsageEndpoint = protectedProcedure
  .input(recipeCookbookScopeInput)
  .output(ingredientUsageSchema)
  .query(async ({ ctx, input }): Promise<IngredientUsage> => {
    return await getIngredientUsage(ctx.db, input?.cookbookId);
  });

// One-shot backfill: recompute every recipe's totals regardless of stale state.
// Admin/recovery (e.g. after the USDA backend was down during a drain). Kept
// non-streaming for the MCP tool, which wants the plain `{processed}` result.
const recomputeAll = protectedProcedure
  .output(recipeRecomputeAllOut)
  .mutation(async ({ ctx }) => {
    return await ctx.services.recipeCosting.recomputeAll();
  });

// Streaming sibling for the maintenance UI button: same work, per-chunk progress.
const recomputeAllStream = protectedProcedure.mutation(async function* ({
  ctx,
}) {
  yield* streamProgress(
    ctx.services.recipeCosting.recomputeAllStream(),
    (r) => r,
  );
});

// DURABLE recompute-all for the maintenance UI: instead of holding this request
// open to do the whole CPU-heavy pass inline (recomputeAllStream — dies on
// navigate-away / PWA background / Worker CPU limit with no record), mark every
// recipe stale and enqueue bounded jobs onto the background-jobs queue, returning
// the batchId so the toast can link to `/background-jobs`. Mirrors
// `ai.backfillLocationDescriptions` (the durable template). Streamed only so it
// reuses the same BackfillButton plumbing; the two `{done,total}` ticks bracket
// the (fast) enqueue, not the actual recompute (which runs on the queue).
const recomputeAllDurable = protectedProcedure.mutation(async function* ({
  ctx,
}) {
  yield* streamProgress(
    ctx.services.recipeCosting.recomputeAllQueued(),
    (r) => r,
  );
});

// Recompute + persist one recipe's totals inline, right now. The manual escape
// hatch for a recipe stuck with null totals in the list (the background drain
// never ran or failed for it) — a single recipe is cheap, so it runs on the
// request path and returns immediately (cascades to parents via `recompute`).
const recomputeOne = protectedProcedure
  .input(recipeIdInput)
  .output(recipeRecomputeAllOut)
  .mutation(async ({ ctx, input }) => {
    const processed = await ctx.services.recipeCosting.recompute([input.id]);
    return { processed };
  });

// Dry run for the force-recompute: how many recipes' totals would actually
// change vs persisted, without writing. Read-only but ~as costly as recomputeAll
// (full engine pass), so the UI triggers it on demand, not on load.
const dryRunRecomputeTotals = protectedProcedure
  .output(recipeDryRunRecomputeTotalsOut)
  .query(async ({ ctx }) => {
    return await ctx.services.recipeCosting.dryRunRecomputeTotals();
  });

// Full costing explanation: persisted totals state vs a fresh compute with
// per-row diagnostics (usage classification, fired consumption rule, exact
// per-measure errors, unit-graph conversion paths), named USDA misses, and
// drift. Read-only — never stamps; consumed by the debug card + MCP tool.
const explainCosting = protectedProcedure
  .input(recipeIdInput)
  .output(recipeCostingExplain)
  .query(async ({ ctx, input }) => {
    return await ctx.services.recipeCosting.explainRecipe(input.id);
  });

// Re-express a value in another unit of the SAME kind (oz→g, tbsp→cup):
// canonicalize both to the kind's base via empty-mapping built-in conversions,
// then divide — the base unit cancels. null if there's no within-kind path.
const convertWithinKind = (
  value: number,
  fromUnit: string,
  toUnit: string,
): number | null => {
  if (fromUnit === toUnit) return value;
  try {
    const kind = wasm.amount_kind({ value: 1, unit: toUnit });
    const from = wasm.conv_amount_to_kind([], kind, { value, unit: fromUnit });
    const per = wasm.conv_amount_to_kind([], kind, { value: 1, unit: toUnit });
    if (!from || !per || !(per.value > 0) || !Number.isFinite(from.value))
      return null;
    return from.value / per.value;
  } catch {
    return null;
  }
};

// On-demand scan: mine ingredient-scoped unit equivalences from recipe lines that
// carry a parenthetical secondary measure (e.g. "1 bunch kale (about 5 cups)"),
// then drop the ones the ingredient's existing conversion graph already covers —
// those add nothing (the costing engine already converts them). Read-only report
// material, NOT part of the eager Problems aggregation, so it runs only on demand.
const harvestEquivalencesEndpoint = protectedProcedure
  .output(equivalenceReportSchema)
  .query(async ({ ctx }): Promise<EquivalenceReport> => {
    const rows = await getMultiMeasureRecipeIngredients(ctx.db);
    const candidates = harvestEquivalences(rows, {
      kindOf: (a) => wasm.amount_kind(a),
      convert: convertWithinKind,
    });
    if (candidates.length === 0) return { candidates: [], hiddenCovered: 0 };

    // Assemble each candidate ingredient's existing conversion graph (its
    // products' stored mappings + USDA portions/serving/nutrition + price).
    const ingredients = await ctx.services.ingredient.getIngredientsByIDs(
      uniq(candidates.map((c) => c.ingredientId)),
    );
    const mappingsById = new Map(
      ingredients.map((ing) => [ing.id, getIngredientMappings(ing)]),
    );

    // What the ingredient's existing graph predicts for 1 unitA → unitB (same
    // display units as `medianRatio`), or null when no path exists (novel).
    // conv_amount_to_kind throws when there's no bridge — caught as null.
    const existingRatioFor = (
      c: (typeof candidates)[number],
    ): number | null => {
      const mappings = mappingsById.get(c.ingredientId);
      if (!mappings || mappings.length === 0) return null;
      try {
        const kindB = wasm.amount_kind({ value: 1, unit: c.unitB });
        const conv = wasm.conv_amount_to_kind(mappings, kindB, {
          value: 1,
          unit: c.unitA,
        });
        if (!conv || !(conv.value > 0) || !Number.isFinite(conv.value))
          return null;
        // conv is in kindB's canonical unit; restate it in unitB to compare.
        return convertWithinKind(conv.value, conv.unit, c.unitB);
      } catch {
        return null;
      }
    };

    // Three outcomes: novel (no existing path) → show plain; covered & agrees
    // (within tolerance) → hide as redundant; covered & disagrees → KEEP and flag
    // with `existingRatio` so the report can warn ("graph says 240, recipes 199").
    const DISAGREE_FACTOR = 1.15; // ≥15% apart counts as a discrepancy
    const visible: CandidateEquivalence[] = [];
    let hiddenCovered = 0;
    for (const c of candidates) {
      const existing = existingRatioFor(c);
      if (existing == null) {
        visible.push(c); // novel
        continue;
      }
      const factor = Math.max(
        existing / c.medianRatio,
        c.medianRatio / existing,
      );
      if (factor <= DISAGREE_FACTOR) {
        hiddenCovered++; // already covered and agrees → redundant
      } else {
        visible.push({ ...c, existingRatio: existing }); // covered but disagrees
      }
    }
    return { candidates: visible, hiddenCovered };
  });

export const recipeAnalysisProcedures = {
  harvestEquivalences: harvestEquivalencesEndpoint,
  recomputeAll,
  recomputeAllStream,
  recomputeAllDurable,
  recomputeOne,
  dryRunRecomputeTotals,
  explainCosting,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
  getDependencyGraph: getDependencyGraphEndpoint,
  getIngredientUsage: getIngredientUsageEndpoint,
};
