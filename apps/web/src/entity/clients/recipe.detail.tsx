import { RecipeActions, RecipeWorkflow } from "~/app/recipes/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const recipeDetailHooks = defineDetailHooks("recipe", {
  slots: { workflow: { component: RecipeWorkflow } },
  headerActions: RecipeActions,
});
