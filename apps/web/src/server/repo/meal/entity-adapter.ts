import {
  defineEntityAdapter,
  deletedWithImages,
} from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";

import {
  createMealWithEntityId,
  deleteMeals,
  getMealByShortcode,
  MEAL_DELETE_EDGE_POLICY,
  mealList,
  updateMeal,
} from "./crud";

const mealShortcodes = bindShortcodeResolver("meal");

export const mealEntityAdapter = defineEntityAdapter({
  entity: "meal",
  lifecycle: { delete: MEAL_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getMealByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      mealList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) =>
      createMealWithEntityId(ctx.db, data, ctx.actorContext),
    update: async (ctx, id, data) => {
      const entityId = await mealShortcodes.one(ctx.db, id);
      const { meal, detachedImageKeys } = await updateMeal(
        ctx.db,
        entityId,
        data,
        ctx.actorContext,
        ctx.caldavHooks?.meal,
      );
      return { output: meal, entityId, detachedImageKeys };
    },
    delete: async (ctx, ids) => {
      const { detachedImageKeys, deletedImageShortcodes } = await deleteMeals(
        ctx.db,
        await mealShortcodes.all(ctx.db, ids),
        ctx.actorContext,
      );
      return {
        deletedReferences: deletedWithImages(
          "meal",
          ids,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
  },
});
