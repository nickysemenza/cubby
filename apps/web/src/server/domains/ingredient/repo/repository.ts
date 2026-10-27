import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  ingredientMergeInput,
  mergeSummary as ingredientMergeSummary,
} from "@cubby/schemas/ingredient";
import { rawIngredientOutput as ingredientOut } from "@cubby/schemas/ingredient-raw-read";
import { z } from "zod";

import { getIngredientByID as getIngredientDetail } from "~/server/domains/ingredient/repo/ingredient-with-food";
import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
} from "~/server/entity-kernel/repo/repository";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

import { createIngredient, getIngredientByID, updateIngredient } from "./crud";
import { deleteIngredients, INGREDIENT_DELETE_EDGE_POLICY } from "./deletion";
import { INGREDIENT_MERGE_EDGE_POLICY, mergeIngredients } from "./merge";
import { ingredientListRead } from "./search";
import { ingredientList } from "./search";

const ingredientShortcodes = bindShortcodeResolver("ingredient");

export const ingredientRepository = defineRepository("ingredient", {
  lifecycle: {
    delete: INGREDIENT_DELETE_EDGE_POLICY,
    merge: INGREDIENT_MERGE_EDGE_POLICY,
  },
  get: async (ctx, shortcode) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, "ingredient");
    return id
      ? getIngredientDetail(
          ctx.db,
          ctx.usdaClient,
          parseEntityId("ingredient", id),
        )
      : null;
  },
  list: listOn(ingredientList),
  listRead: listReadOn(ingredientListRead),
  create: asActor(createIngredient),
  update: async (ctx, shortcode, data) => {
    const entityId = await ingredientShortcodes.one(ctx.db, shortcode);
    const output = await updateIngredient(
      ctx.db,
      entityId,
      data,
      ctx.actorContext,
    );
    await ctx.services.recipeCosting.recomputeForIngredient(entityId, {
      source: "ingredient.update",
      entity: { entityKind: "ingredient", entityId },
    });
    return { output, entityId };
  },
  updateRead: async (ctx, shortcode, data, fields) => {
    const entityId = await ingredientShortcodes.one(ctx.db, shortcode);
    const result = await updateIngredient.read(
      fields,
      ctx.db,
      entityId,
      data,
      ctx.actorContext,
    );
    await ctx.services.recipeCosting.recomputeForIngredient(entityId, {
      source: "ingredient.update",
      entity: { entityKind: "ingredient", entityId },
    });
    return result;
  },
  delete: async (ctx, shortcodes) => {
    const ids = await ingredientShortcodes.all(ctx.db, shortcodes);
    await deleteIngredients(ctx.db, ids, ctx.actorContext);
    await recordChange(ctx.db, { kind: "source", categories: ["ingredient"] });
  },
  merge: {
    input: ingredientMergeInput,
    output: z.object({
      ingredient: ingredientOut,
      mergeSummary: ingredientMergeSummary,
    }),
    item: (output) => output.ingredient,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const summary = await mergeIngredients(ctx.db, input, ctx.actorContext);
      const entityId = await ingredientShortcodes.one(ctx.db, input.keepId);
      await ctx.services.recipeCosting.dispatchRecompute(
        summary.affectedRecipeIds,
        {
          source: "ingredient.merge",
          entity: { entityKind: "ingredient", entityId },
        },
      );
      await recordChange(ctx.db, {
        kind: "source",
        categories: ["ingredient"],
      });
      return {
        output: {
          ingredient: await getIngredientByID(ctx.db, entityId),
          mergeSummary: ingredientMergeSummary.parse(summary),
        },
        entityId,
        detachedImageKeys: [],
      };
    },
  },
});
