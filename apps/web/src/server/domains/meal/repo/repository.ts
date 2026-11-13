import { mealSchemaBindings } from "~/entity/generated/entity-schema-bindings.meal.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createMealWithEntityId,
  deleteMeals,
  mealScaffold,
  updateMeal,
} from "./crud";

const mealShortcodes = bindShortcodeResolver("meal");

export const mealRepository = defineRepository("meal", {
  schemas: mealSchemaBindings,
  lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.meal },
  scaffold: mealScaffold,
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
  updateRead: async (ctx, id, data, fields) =>
    updateMeal.read(
      fields,
      ctx.db,
      await mealShortcodes.one(ctx.db, id),
      data,
      ctx.actorContext,
      ctx.caldavHooks?.meal,
    ),
  delete: async (ctx, ids) =>
    deleteMeals(
      ctx.db,
      await mealShortcodes.all(ctx.db, ids),
      ctx.actorContext,
    ),
});
