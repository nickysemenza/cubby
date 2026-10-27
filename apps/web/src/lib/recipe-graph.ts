import type {
  IngredientShortcode,
  RecipeShortcode,
} from "@cubby/schemas/identifiers";
import type { SectionIngredient } from "@cubby/schemas/recipe";
import { match } from "ts-pattern";

type IngredientLine = Extract<SectionIngredient, { type: "ingredient" }>;
type SubRecipeLine = Extract<SectionIngredient, { type: "recipe" }>;
type GraphLine =
  | (Pick<IngredientLine, "type"> & {
      ingredient: Pick<IngredientLine["ingredient"], "id" | "name">;
    })
  | (Pick<SubRecipeLine, "type"> & {
      recipe: Pick<SubRecipeLine["recipe"], "id" | "name">;
    });
export type RecipeGraphRecipe = Pick<SubRecipeLine["recipe"], "id"> & {
  sections: { ingredients: GraphLine[] }[];
};

export const getRecipeIngredientName = (ingredient: GraphLine): string =>
  match(ingredient)
    .with({ type: "ingredient" }, (i) => i.ingredient.name)
    .with({ type: "recipe" }, (i) => i.recipe.name)
    .exhaustive();

export const collectSubRecipeIds = (
  recipes: readonly RecipeGraphRecipe[],
): RecipeShortcode[] => {
  const ids = new Set<RecipeShortcode>();
  for (const recipe of recipes) {
    for (const section of recipe.sections) {
      for (const ingredient of section.ingredients) {
        if (ingredient.type === "recipe") ids.add(ingredient.recipe.id);
      }
    }
  }
  return [...ids];
};

export const collectIngredientIds = (
  recipes: readonly RecipeGraphRecipe[],
): IngredientShortcode[] => {
  const ids = new Set<IngredientShortcode>();
  for (const recipe of recipes) {
    for (const section of recipe.sections) {
      for (const ingredient of section.ingredients) {
        if (ingredient.type === "ingredient") ids.add(ingredient.ingredient.id);
      }
    }
  }
  return [...ids];
};

const recipeIngredientLinkSignature = (ingredient: GraphLine): string =>
  ingredient.type === "ingredient"
    ? ingredient.ingredient.id
    : `r${ingredient.recipe.id}`;

/**
 * Stable signature for the ingredient/sub-recipe links a costing context depends
 * on. Amount edits intentionally do not affect this: they change the cost pass,
 * not which supporting records need to be fetched.
 */
export const recipeLinkSignature = (
  recipes: readonly RecipeGraphRecipe[],
): string =>
  recipes
    .map(
      (recipe) =>
        `${recipe.id}:${recipe.sections
          .flatMap((section) =>
            section.ingredients.map(recipeIngredientLinkSignature),
          )
          .join("-")}`,
    )
    .join(",");
