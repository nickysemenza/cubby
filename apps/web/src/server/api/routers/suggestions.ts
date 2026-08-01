/**
 * Suggestions Router — "what can I make?"
 *
 * Read-only surface over the Phase 0 AvailabilityService: single-recipe coverage
 * plus a ranked "what's makeable from current inventory" list. Consumed by the
 * /meals/suggestions UI and the find_cookable_recipes MCP tool.
 */

import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import {
  makeableRecipesInput,
  makeableRecipesOut,
  recipeAvailabilityInput,
} from "@cubby/schemas/suggestions";
import pMap from "p-map";
import { recipeList } from "~/server/repo/recipe";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

/** Upper bound on recipes scored per getMakeable call (ranking is O(n) availability calls). */
const CANDIDATE_CAP = 500;

const getRecipeAvailability = protectedProcedure
  .input(recipeAvailabilityInput)
  .output(strictOutput(recipeAvailabilityOut))
  .query(async ({ ctx, input }) =>
    ctx.services.availability.getRecipeAvailability(input.recipeId),
  );

const getMakeable = protectedProcedure
  .input(makeableRecipesInput)
  .output(strictOutput(makeableRecipesOut))
  .query(async ({ ctx, input }) => {
    const minCoverage = input.minCoverage ?? 0;
    const limit = input.limit ?? 24;

    // Score every (capped) recipe against inventory, then rank by coverage.
    // This is O(recipes × ingredients × inventory) — fine at current scale, but a
    // known scaling cost. CANDIDATE_CAP bounds the fan-out.
    // Sub-recipes are excluded: a recipe used as an ingredient is a component of
    // a meal, not an answer to "what can I make tonight?".
    const { data: recipes, count } = await recipeList(
      ctx.db,
      { excludeSubRecipes: true },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: CANDIDATE_CAP },
    );

    const availabilities = await pMap(
      recipes,
      (r) => ctx.services.availability.getRecipeAvailability(r.id),
      { concurrency: 8 },
    );

    return {
      recipes: availabilities
        .filter((a) => a.coverage >= minCoverage)
        .sort((a, b) => b.coverage - a.coverage)
        .slice(0, limit),
      truncated: count > CANDIDATE_CAP,
      candidateCap: CANDIDATE_CAP,
    };
  });

export const suggestionsRouter = createTRPCRouter({
  getRecipeAvailability,
  getMakeable,
});
