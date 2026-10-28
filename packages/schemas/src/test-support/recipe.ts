import { recipeOut } from "@cubby/schemas/entities/recipe";
import { z } from "zod";

import { sectionIngredientOut } from "../recipe";
import { testCompleteDataQuality } from "./identifiers";

/** Shared builders for the recipe-shaped rows web tests render. */

type LineInput = z.input<typeof sectionIngredientOut>;
type RecipeInput = z.input<typeof recipeOut>;

/** Read fixtures supply outcomes without inventing stored assignment authority. */
function readFields(
  schemas: z.ZodRawShape,
  values: Readonly<
    Record<string, z.output<ReturnType<typeof z.json>> | undefined>
  >,
) {
  return Object.fromEntries(
    Object.entries(schemas).map(([key, schema]) => {
      if (!(schema instanceof z.ZodType))
        throw new Error("Fixture field schema missing");
      const value = values[key];
      return [
        key,
        schema.parse({
          current: {
            assignment: null,
            controls: { kind: "readonly", reason: "computed" },
          },
          result:
            value === undefined
              ? { kind: "missing" }
              : {
                  kind: "live",
                  decision: {
                    outcome:
                      value === null
                        ? { kind: "empty", reason: "unset" }
                        : { kind: "value", value },
                    provenance: { kind: "computed" },
                  },
                },
          work: { kind: "idle" },
        }),
      ];
    }),
  );
}

const STAMP = {
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** A recipe section line pointing at an Ingredient. */
export const testIngredientLine = (line: {
  id: LineInput["id"];
  ingredientId: NonNullable<LineInput["ingredient"]>["id"];
  name: string;
}) =>
  sectionIngredientOut.parse({
    id: line.id,
    type: "ingredient",
    amounts: [],
    modifier: null,
    rawLine: null,
    recipe: null,
    ingredient: {
      id: line.ingredientId,
      name: line.name,
      aliases: [],
      naKinds: [],
      ...STAMP,
    },
    ...STAMP,
  });

/** A recipe section line pointing at another Recipe, with an optional written amount. */
export const testSubRecipeLine = (line: {
  id: LineInput["id"];
  recipeId: NonNullable<LineInput["recipe"]>["id"];
  name: string;
  amounts?: LineInput["amounts"];
}) =>
  sectionIngredientOut.parse({
    id: line.id,
    type: "recipe",
    amounts: line.amounts ?? [],
    modifier: null,
    rawLine: null,
    ingredient: null,
    recipe: {
      fields: readFields(
        sectionIngredientOut.options[1].shape.recipe.shape.fields.shape,
        { source: null, servings: null, tags: [] },
      ),
      id: line.recipeId,
      name: line.name,
      meta: null,
      forkedFromRecipeId: null,
      forkedFromRecipeName: null,
      ...STAMP,
    },
    ...STAMP,
  });

/** A Recipe with no sections, images, or tags. */
export const testEmptyRecipe = (recipe: {
  id: RecipeInput["id"];
  name: string;
}) =>
  recipeOut.parse({
    fields: readFields(recipeOut.shape.fields.shape, {
      source: null,
      servings: null,
      tags: [],
      images: [],
      dataQuality: testCompleteDataQuality(),
    }),
    id: recipe.id,
    name: recipe.name,
    meta: null,
    yield: null,
    servings: null,
    notes: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    source: null,
    images: [],
    sections: [],
    tags: [],
    ...STAMP,
    dataQuality: testCompleteDataQuality(),
  });
