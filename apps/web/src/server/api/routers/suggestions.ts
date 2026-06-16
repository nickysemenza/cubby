/**
 * Suggestions Router — "what can I make?"
 *
 * Read-only surface over the Phase 0 AvailabilityService: single-recipe coverage
 * plus a ranked "what's makeable from current inventory" list. Consumed by the
 * /meals/suggestions UI and the find_cookable_recipes MCP tool.
 */

import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import { recipeId } from "@cubby/schemas/identifiers";
import { z } from "zod";
import { recipeList } from "~/server/repo/recipe";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/** Upper bound on recipes scored per getMakeable call (ranking is O(n) availability calls). */
const CANDIDATE_CAP = 500;

const getRecipeAvailability = protectedProcedure
  .input(z.object({ recipeId }))
  .output(recipeAvailabilityOut)
  .query(async ({ ctx, input }) =>
    ctx.services.availability.getRecipeAvailability(input.recipeId),
  );

const getMakeable = protectedProcedure
  .input(
    z.object({
      minCoverage: z.number().min(0).max(1).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
  )
  .output(z.array(recipeAvailabilityOut))
  .query(async ({ ctx, input }) => {
    const minCoverage = input.minCoverage ?? 0;
    const limit = input.limit ?? 24;

    // Score every (capped) recipe against inventory, then rank by coverage.
    // This is O(recipes × ingredients × inventory) — fine at current scale, but a
    // known scaling cost. CANDIDATE_CAP bounds the fan-out.
    const { data: recipes } = await recipeList(
      ctx.db,
      {},
      { orderBy: "name", direction: "asc" },
      { pageIndex: 0, pageSize: CANDIDATE_CAP },
    );

    const availabilities = await Promise.all(
      recipes.map((r) => ctx.services.availability.getRecipeAvailability(r.id)),
    );

    return availabilities
      .filter((a) => a.coverage >= minCoverage)
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, limit);
  });

export const suggestionsRouter = createTRPCRouter({
  getRecipeAvailability,
  getMakeable,
});
