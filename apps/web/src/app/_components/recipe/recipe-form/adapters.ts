import type {
  RecipeCreateInput,
  RecipeIngredientInput,
  RecipeOut,
  RecipeUpdateInput,
  recipeInstructionInput,
  recipeSectionInput,
} from "@cubby/schemas/recipe";
import { match, P } from "ts-pattern";
import type { z } from "zod";
import {
  getOptionalIngredientId,
  getOptionalRecipeId,
} from "~/app/_components/form-fields";
import { buildUpdateObject } from "../../form-utils";
import {
  haveIngredientsChanged,
  haveInstructionsChanged,
  normalizeAmounts,
} from "./recipe-form-utils";
import type { IngItem, RecipeFormValues } from "./types";

type RecipeImageChanges = Pick<RecipeCreateInput, "pendingImageIds"> &
  Pick<RecipeUpdateInput["data"], "removeImageIds">;

const blankAmount = { value: null, unit: "" };

export const recipeToFormValues = (
  recipe: RecipeOut | undefined,
  initialName?: string,
  initialUrl?: string,
): RecipeFormValues => ({
  name: recipe ? recipe.name : (initialName ?? ""),
  meta: recipe ? recipe.meta : initialUrl ? { url: initialUrl } : null,
  yield: recipe?.yield ?? null,
  servings: recipe?.servings ?? null,
  tags: recipe?.tags ?? [],
  notes: recipe?.notes ?? null,
  sections: recipe
    ? recipe.sections.map((section) => ({
        id: section.id,
        name: section.name,
        ingredients: section.ingredients.map(
          (ing): IngItem =>
            match(ing)
              .with({ type: "ingredient" }, (ing) => ({
                id: ing.id,
                type: "ingredient" as const,
                ingredient: {
                  id: ing.ingredient.id,
                  name: ing.ingredient.name,
                },
                recipe: null,
                amounts: ing.amounts.length > 0 ? ing.amounts : [blankAmount],
                rawLine: ing.rawLine ?? null,
                modifier: ing.modifier ?? null,
                aliases: ing.ingredient.aliases ?? [],
              }))
              .with({ type: "recipe" }, (ing) => ({
                id: ing.id,
                type: "recipe" as const,
                ingredient: null,
                recipe: {
                  id: ing.recipe.id,
                  name: ing.recipe.name,
                },
                amounts: ing.amounts.length > 0 ? ing.amounts : [blankAmount],
                rawLine: ing.rawLine ?? null,
                modifier: ing.modifier ?? null,
              }))
              .exhaustive(),
        ),
        instructions: section.instructions,
      }))
    : [
        {
          name: null,
          ingredients: [],
          instructions: [],
        },
      ],
});

const mapIngredientToApiFormat = (ing: IngItem): RecipeIngredientInput =>
  match(ing)
    .with({ type: "ingredient", ingredient: P.nonNullable }, (ing) => ({
      type: "ingredient" as const,
      ingredientId: getOptionalIngredientId(ing.ingredient)!,
      recipeId: null,
      amounts: normalizeAmounts(ing.amounts),
      id: ing.id,
      rawLine: ing.rawLine ?? undefined,
      modifier: ing.modifier ?? undefined,
    }))
    .with({ type: "recipe", recipe: P.nonNullable }, (ing) => ({
      type: "recipe" as const,
      recipeId: getOptionalRecipeId(ing.recipe)!,
      ingredientId: null,
      amounts: normalizeAmounts(ing.amounts),
      id: ing.id,
      rawLine: ing.rawLine ?? undefined,
      modifier: ing.modifier ?? undefined,
    }))
    // type says ingredient/recipe but the nested data isn't filled yet.
    .otherwise((ing) => {
      throw new Error(
        `Invalid ingredient type or missing data: ${JSON.stringify(ing)}`,
      );
    });

const mapSectionToApiFormat = (
  section: RecipeFormValues["sections"][number],
): z.infer<typeof recipeSectionInput> => {
  const ingredients = section.ingredients.map(mapIngredientToApiFormat);
  return {
    name: section.name,
    ingredients: ingredients.length > 0 ? ingredients : undefined,
    instructions:
      section.instructions.length > 0 ? section.instructions : undefined,
  };
};

const normalizeRecipeFormBasics = (values: RecipeFormValues) => ({
  yield:
    values.yield?.value != null && values.yield.unit
      ? { value: values.yield.value, unit: values.yield.unit }
      : null,
  meta: values.meta?.url ? { url: values.meta.url } : null,
  notes: values.notes?.trim() ? values.notes : null,
});

export const recipeFormValuesToCreateInput = (
  values: RecipeFormValues,
  imageChanges: RecipeImageChanges,
): RecipeCreateInput => {
  const normalized = normalizeRecipeFormBasics(values);
  return {
    name: values.name,
    meta: normalized.meta,
    yield: normalized.yield,
    servings: values.servings,
    tags: values.tags,
    notes: normalized.notes,
    sections: values.sections.map(mapSectionToApiFormat),
    ...imageChanges,
  };
};

export const recipeFormValuesToUpdateInput = (
  values: RecipeFormValues,
  recipe: RecipeOut,
  imageChanges: RecipeImageChanges,
  hasImageChanges: boolean,
): RecipeUpdateInput | null => {
  const normalized = normalizeRecipeFormBasics(values);
  const basicUpdates = buildUpdateObject(
    recipe,
    {
      ...values,
      yield: normalized.yield,
      meta: normalized.meta,
      notes: normalized.notes,
    },
    ["name", "meta", "yield", "servings", "tags", "notes"],
  );

  const sectionUpdates = values.sections.map((section, idx) => {
    const originalSection = recipe.sections[idx];
    if (!originalSection || !section.id) return mapSectionToApiFormat(section);

    const sectionUpdate: z.infer<typeof recipeSectionInput> = {
      id: section.id,
    };
    if (originalSection.name !== section.name)
      sectionUpdate.name = section.name;

    if (
      haveIngredientsChanged(originalSection.ingredients, section.ingredients)
    ) {
      sectionUpdate.ingredients = section.ingredients.map(
        mapIngredientToApiFormat,
      );
    }

    if (
      haveInstructionsChanged(
        originalSection.instructions,
        section.instructions,
      )
    ) {
      sectionUpdate.instructions = section.instructions.map((inst) => {
        const output: z.infer<typeof recipeInstructionInput> = {
          instruction: inst.instruction,
        };
        if (inst.id) output.id = inst.id;
        return output;
      });
    }

    return sectionUpdate;
  });

  const hasFieldChanges =
    Object.keys(basicUpdates).length > 0 ||
    sectionUpdates.some((section) => Object.keys(section).length > 1);

  if (!hasFieldChanges && !hasImageChanges) return null;

  return {
    id: recipe.id,
    data: {
      ...basicUpdates,
      sections: sectionUpdates,
      ...imageChanges,
    },
  };
};
