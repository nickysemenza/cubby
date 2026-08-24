/**
 * Ingredient Router - Uses service layer
 *
 * Ingredients integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the ingredient service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import {
  ingredientShortcode,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import {
  enrichmentRowsOut,
  ingredientIdInput,
  ingredientIdsInput,
  ingredientListItemOut,
  ingredientMatchesOut,
  ingredientMergeInput,
  ingredientMergeOut,
  ingredientNameFilterInput,
  ingredientNamesInput,
  ingredientOut,
  ingredientRecipeUsagesOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateOut,
  ingredientWithFoodLeanListOut,
  ingredientWithFoodOut,
} from "@cubby/schemas/ingredient";
import { z } from "zod";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_KERNEL_BINDINGS } from "~/server/entity-kernel/registry";
import {
  getIngredientMatches,
  getRecipeUsagesForIngredient,
  resolveOrCreateIngredients,
} from "~/server/repo/ingredient";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  enrichmentWorkbench as enrichmentWorkbenchService,
  getIngredientByID,
  getIngredientByName,
  getIngredientsByIDs,
} from "~/server/services/ingredient.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createEntityCompatibilityProcedures } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const ingredientShortcodes = bindShortcodeResolver("ingredient");
const recipeShortcodes = bindShortcodeResolver("recipe");

const {
  list,
  create,
  update,
  delete: deleteItem,
} = createEntityCompatibilityProcedures(ENTITY_KERNEL_BINDINGS.ingredient, {
  ...ENTITY_BINDINGS.ingredient.crud,
  listOutput: ingredientListItemOut,
});

// Recipe usage and food joins are a detail projection, not part of canonical
// ingredient CRUD.
const getByID = protectedProcedure
  .input(z.object({ id: ingredientShortcode }))
  .output(strictOutput(ingredientWithFoodOut))
  .query(async ({ ctx, input }) =>
    getIngredientByID(
      ctx.db,
      ctx.usdaClient,
      await ingredientShortcodes.one(ctx.db, input.id),
    ),
  );

const merge = protectedProcedure
  .input(ingredientMergeInput)
  .output(
    strictOutput(
      z.object({
        ingredient: ingredientOut,
        mergeSummary: ingredientMergeOut.shape.mergeSummary,
        sideEffects: mutationSideEffectsSchema,
      }),
    ),
  )
  .mutation(async ({ ctx, input }) => {
    const result = await executeEntity(ctx, {
      action: "merge",
      entity: "ingredient",
      data: input,
    });
    if (result.action !== "merge")
      throw new Error("Entity kernel returned the wrong action");
    return {
      ingredient: ingredientOut.parse(result.item),
      mergeSummary: ingredientMergeOut.shape.mergeSummary.parse(
        result.mergeSummary,
      ),
      sideEffects: result.sideEffects,
    };
  });

// The enrichment workbench worklist: recipe-used ingredients that aren't fully
// costable, with coverage + recommended fix computed server-side.
const enrichmentWorkbench = protectedProcedure
  .input(
    z
      .object({
        recipeId: recipeShortcode.optional(),
        focusId: ingredientShortcode.optional(),
      })
      .optional(),
  )
  .output(strictOutput(enrichmentRowsOut))
  .query(async ({ ctx, input }) => {
    const recipeId = input?.recipeId
      ? await recipeShortcodes.one(ctx.db, input.recipeId)
      : undefined;
    const focusId = input?.focusId
      ? await ingredientShortcodes.one(ctx.db, input.focusId)
      : undefined;
    return await enrichmentWorkbenchService(ctx.db, ctx.usdaClient, {
      recipeId,
      focusId,
      focusShortcode: input?.focusId,
    });
  });

// On-demand recipe usages for one ingredient. The workbench's expanded-row footer
// fetches this lazily so the worklist query itself stays lean — it no longer
// ships every usage's recipe body per row (see enrichmentWorkbenchIngredients).
const recipeUsages = protectedProcedure
  .input(ingredientIdInput)
  .output(strictOutput(ingredientRecipeUsagesOut))
  .query(async ({ ctx, input }) => {
    const usages = await getRecipeUsagesForIngredient(
      ctx.db,
      await ingredientShortcodes.one(ctx.db, input.id),
    );
    return usages.recipeUsages;
  });

const getByName = protectedProcedure
  .input(ingredientNameFilterInput)
  .output(strictOutput(ingredientWithFoodOut.nullable()))
  .query(async ({ ctx, input }) => {
    return await getIngredientByName(ctx.db, ctx.usdaClient, input.nameFilter);
  });

// Batch name→match lookup in one query. The cookbook importer uses this to show
// the matched/new status for a whole book's ingredients at once, instead of one
// getByName per ingredient per recipe card (hundreds of round-trips).
const matchNames = protectedProcedure
  .input(ingredientNamesInput)
  .output(strictOutput(ingredientMatchesOut))
  .query(async ({ ctx, input }) => {
    return await getIngredientMatches(ctx.db, input.names);
  });

// Batch resolve-or-create in one round-trip: each name is matched to an existing
// standalone ingredient (case-insensitive on name/aliases) or created. Returns one
// entry per name with `matched`/`created` flags, so an agent can collapse the
// search_ingredients-then-create_ingredient loop (dozens of calls) into one.
const resolveOrCreate = protectedProcedure
  .input(ingredientResolvableNamesInput)
  .output(strictOutput(ingredientResolveOrCreateOut))
  .mutation(async ({ ctx, input }) => {
    const result = await resolveOrCreateIngredients(ctx.db, input.names);
    const created = result.filter((ingredient) => ingredient.created);
    await runMutationSideEffectsForEntities(
      ctx.db,
      created.map((ingredient) => ({
        action: "created" as const,
        entity: {
          entityType: "ingredient" as const,
          entityId: ingredient.entityId,
        },
        source: "ingredient.resolveOrCreate",
      })),
    );
    return result;
  });

// Batched id→ingredient lookup in one query (+ one cross-ingredient USDA enrich).
// The recipe list uses this to load every ingredient for its cost/calorie columns
// in a single round-trip instead of one getByID per ingredient (hundreds).
const getManyByIDs = protectedProcedure
  .input(ingredientIdsInput)
  // Lean output: products + food only (the consumer computes costs and reads no
  // recipe-usage data) — the full ingredient graph's per-usage recipe bodies were
  // a ~1s over-fetch on a recipe's ingredient set.
  .output(strictOutput(ingredientWithFoodLeanListOut))
  .query(async ({ ctx, input }) => {
    return await getIngredientsByIDs(
      ctx.db,
      ctx.usdaClient,
      await ingredientShortcodes.all(ctx.db, input.ids),
    );
  });

export const ingredientRouter = createTRPCRouter({
  getByName,
  enrichmentWorkbench,
  recipeUsages,
  matchNames,
  resolveOrCreate,
  getByID,
  getManyByIDs,
  list,
  merge,
  create,
  update,
  delete: deleteItem,
});
