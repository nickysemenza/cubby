import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";

import {
  createMealWithEntityId,
  deleteMeals,
  getMealByShortcode,
  MEAL_DELETE_EDGE_POLICY,
  mealList,
  mealListRead,
  updateMeal,
} from "./crud";

const mealShortcodes = bindShortcodeResolver("meal");

export const mealRepository = defineRepository("meal", {
  lifecycle: { delete: MEAL_DELETE_EDGE_POLICY },
  get: onDb(getMealByShortcode),
  list: listOn(mealList),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    mealListRead(ctx.db, filters, sorts, pagination, "page", projection),
  create: asActor(createMealWithEntityId),
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
  delete: async (ctx, ids) =>
    deleteMeals(
      ctx.db,
      await mealShortcodes.all(ctx.db, ids),
      ctx.actorContext,
    ),
});
