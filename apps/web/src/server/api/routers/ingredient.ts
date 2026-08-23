/**
 * Ingredient Router - Uses service layer
 *
 * Ingredients integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the ingredient service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  type IngredientShortcode,
  ingredientShortcode,
  recipeShortcode,
  unsafeIngredientId,
} from "@cubby/schemas/identifiers";
import {
  enrichmentRowsOut,
  ingredientCreateInput,
  ingredientFiltersSchema,
  ingredientIdInput,
  ingredientIdsInput,
  ingredientListItemOut,
  ingredientMatchesOut,
  ingredientMergeInput,
  ingredientMergeOut,
  ingredientNameFilterInput,
  ingredientNamesInput,
  ingredientRecipeUsagesOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateOut,
  ingredientSortableFields,
  ingredientUpdateInput,
  ingredientWithFoodAndSideEffectsOut,
  ingredientWithFoodLeanListOut,
  ingredientWithFoodOut,
} from "@cubby/schemas/ingredient";
import { z } from "zod";
import {
  deleteIngredients,
  getIngredientMatches,
  getRecipeUsagesForIngredient,
  ingredientList,
  mergeIngredients,
  resolveOrCreateIngredients,
} from "~/server/repo/ingredient";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import {
  createIngredient as createIngredientService,
  enrichmentWorkbench as enrichmentWorkbenchService,
  getIngredientByID,
  getIngredientByName,
  getIngredientsByIDs,
  updateIngredient as updateIngredientService,
} from "~/server/services/ingredient.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const ingredientShortcodes = bindShortcodeResolver("ingredient");
const recipeShortcodes = bindShortcodeResolver("recipe");

// Update is customized so it can eagerly recompute dependent recipes and report side-effects.
// List returns a lean summary (lean ingredient + food + {id,name} recipe refs, no
// per-usage recipe bodies); detail (getByID/create) keeps the full
// ingredientWithFoodOut. Split into the two sub-factories so each surface carries
// its own output schema. (update is customized below.)
const { list } = createEntityListProcedure({
  schemas: {
    output: ingredientListItemOut,
    filters: ingredientFiltersSchema,
    sort: {
      sortableFields: ingredientSortableFields,
      defaultSort: "createdAt",
    },
  },
  repository: {
    // Straight repo call — the list path does no USDA enrichment, so per the
    // service-boundary rule there's no service layer here.
    list: async (services, filters, sort, pagination) => {
      return await ingredientList(services.db, filters, sort, pagination);
    },
  },
  entityName: "ingredient",
});

const { getByID, getByShortcode, create } =
  createEntityCrudWithoutListProcedures({
    entityName: "ingredient",
    schemas: {
      createInput: ingredientCreateInput,
      output: ingredientWithFoodOut,
      createOutput: ingredientWithFoodAndSideEffectsOut,
      idSchema: ingredientShortcode,
    },
    repository: {
      getByID: async (services, id: IngredientShortcode) => {
        return await getIngredientByID(
          services.db,
          services.usdaClient,
          await ingredientShortcodes.one(services.db, id),
        );
      },
      // Resolves the shortcode itself: `getByID` above returns the
      // USDA-enriched shape (`ingredientWithFoodOut`), which the plain repo
      // reader's `getByShortcode` (unenriched) doesn't produce, and the
      // factory requires both procedures to share one output schema.
      getByShortcode: async (services, shortcode) => {
        const id = await resolveLiveShortcode(
          services.db,
          shortcode,
          "ingredient",
        );
        return id
          ? await getIngredientByID(
              services.db,
              services.usdaClient,
              unsafeIngredientId(id),
            )
          : null;
      },
      create: async (services, data) => {
        const ingredient = await createIngredientService(
          services.db,
          services.usdaClient,
          data,
          services.actorContext,
        );
        const entityId = await ingredientShortcodes.one(
          services.db,
          ingredient.id,
        );
        const backgroundBatches = await runMutationSideEffects(services.db, {
          action: "created",
          entity: { entityType: "ingredient", entityId },
          source: "ingredient.create",
        });
        return { ...ingredient, sideEffects: { backgroundBatches } };
      },
    },
  });

// Custom update: an ingredient edit changes its contribution to recipe cost, so
// recompute every dependent recipe eagerly (covers UI + MCP, which both call
// through this proc) and report the count.
const update = protectedProcedure
  .input(ingredientUpdateInput)
  .output(strictOutput(ingredientWithFoodAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const entityId = await ingredientShortcodes.one(ctx.db, input.id);
    const result = await updateIngredientService(
      ctx.db,
      ctx.usdaClient,
      entityId,
      input.data,
      ctx.actorContext,
    );
    const backgroundBatches = await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "ingredient", entityId },
      source: "ingredient.update",
    });
    const recipeBatches =
      await ctx.services.recipeCosting.recomputeForIngredient(entityId, {
        source: "ingredient.update",
        entity: { entityType: "ingredient", entityId },
      });
    return {
      ...result,
      sideEffects: {
        backgroundBatches: [...backgroundBatches, ...recipeBatches],
      },
    };
  });

// Calls the repo directly: the service wrapper this used to go through only
// ran the merge and then re-read the survivor, which is a pass-through, and
// the layering rule reserves the service layer for cross-cutting
// enrichment/compute. The survivor read is `getIngredientByID` right here.
const merge = protectedProcedure
  .input(ingredientMergeInput)
  .output(strictOutput(ingredientMergeOut))
  .mutation(async ({ ctx, input }) => {
    // Shortcodes go in whole: `mergeIngredients` resolves them itself through
    // the shared `resolveMergeTargets`, which is also what refuses a
    // self-merge before anything is written.
    const summary = await mergeIngredients(ctx.db, input, ctx.actorContext);
    const keepEntityId = await ingredientShortcodes.one(ctx.db, input.keepId);
    const merged = await getIngredientByID(
      ctx.db,
      ctx.usdaClient,
      keepEntityId,
    );
    // The merge marked the absorbed recipes stale in-transaction; dispatch their
    // recompute OFF the request path (queue in prod, inline in dev) so a
    // heavily-used keeper can't overrun the Workers budget and sink the mutation.
    const recipeBatches = await ctx.services.recipeCosting.dispatchRecompute(
      summary.affectedRecipeIds,
      {
        source: "ingredient.merge",
        entity: { entityType: "ingredient", entityId: keepEntityId },
      },
    );
    const backgroundBatches = await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "ingredient", entityId: keepEntityId },
      source: "ingredient.merge",
    });
    const deletedBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      summary.deletedEntityIds.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "ingredient" as const, entityId: id },
        source: "ingredient.merge",
      })),
    );
    return {
      ...merged,
      sideEffects: {
        backgroundBatches: [
          ...recipeBatches,
          ...backgroundBatches,
          ...deletedBatches,
        ],
      },
      mergeSummary: {
        aliasesAdded: summary.aliasesAdded,
        recipesMoved: summary.recipesMoved,
        productsMoved: summary.productsMoved,
        merged: summary.merged,
        deletedIds: summary.deletedIds,
      },
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

const deleteItem = createDeleteProcedure<IngredientShortcode>(
  async (services, shortcodes) => {
    const ids = await ingredientShortcodes.all(services.db, shortcodes);
    const { deleted } = await deleteIngredients(
      services.db,
      ids,
      services.actorContext,
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      services.db,
      ids.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "ingredient" as const, entityId: id },
        source: "ingredient.delete",
      })),
    );
    return { deleted, backgroundBatches };
  },
  ingredientShortcode,
);

export const ingredientRouter = createTRPCRouter({
  getByName,
  enrichmentWorkbench,
  recipeUsages,
  matchNames,
  resolveOrCreate,
  getByID,
  getByShortcode,
  getManyByIDs,
  list,
  merge,
  create,
  update,
  delete: deleteItem,
});
