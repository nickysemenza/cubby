import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { recipeTopLevel, type SectionIngredient } from "@cubby/schemas/recipe";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { expect, it } from "vitest";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { entityReadFixture } from "~/entity/fields/field-envelope.fixtures";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { servingBasisFixture } from "~/features/recipe/recipe-read.fixtures";

import {
  getEffectiveServings,
  getIngredientName,
  getRecipeNutritionBasis,
  getServingBasis,
} from "./recipe-utils";
import { formatYield } from "./recipe-yield";

it("reads the serving envelope without recomputing a fallback from yield", () => {
  expect(
    getEffectiveServings({
      yield: { value: 10, unit: "servings" },
      fields: {
        servings: {
          current: {
            assignment: { kind: "inherit" },
            controls: {
              kind: "editable",
              canSetNone: true,
              canConfirm: true,
              reset: { kind: "unavailable" },
            },
          },
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "value", value: 4 },
              provenance: { kind: "default", source: null },
            },
          },
          work: { kind: "idle" },
        },
      },
    }),
  ).toBe(4);
  expect(
    getEffectiveServings({
      fields: {
        servings: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
            "servings"
          ],
          null,
        ),
      },

      yield: { value: 2.5, unit: "servings" },
    }),
  ).toBeNull();
  expect(
    getServingBasis({
      yield: { value: 10, unit: "servings" },
      fields: {
        servings: {
          current: {
            assignment: { kind: "inherit" },
            controls: {
              kind: "editable",
              canSetNone: true,
              canConfirm: true,
              reset: { kind: "unavailable" },
            },
          },
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "value", value: 4 },
              provenance: { kind: "default", source: null },
            },
          },
          work: { kind: "idle" },
        },
      },
    }),
  ).toEqual({ divisor: 4, noun: "serving" });
});

it("recipe utils", () => {
  const recipe: RecipeOut = entityReadFixture(
    entityFieldEnvelopeSchemas.recipe.detail,
    {
      fields: {
        images: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape["images"],
          [],
        ),
        dataQuality: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
            "dataQuality"
          ],
          testCompleteDataQuality(),
        ),
      },
      sections: [
        {
          ingredients: [],
          instructions: [],
          id: "00000000-0000-4000-8000-000000000001",
          name: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          ingredients: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              type: "ingredient",
              createdAt: new Date(),
              updatedAt: new Date(),
              recipe: null,
              ingredient: {
                id: testShortcode("ingredient", "ING-2345"),
                name: "flour-i",
                createdAt: new Date(),
                updatedAt: new Date(),
              },
              amounts: [],
            },
            {
              id: "00000000-0000-4000-8000-000000000003",
              type: "recipe",
              createdAt: new Date(),
              updatedAt: new Date(),
              ingredient: null,
              recipe: entityReadFixture(recipeTopLevel, {
                id: testShortcode("recipe", "RCP-2345"),
                name: "flour-r",
                createdAt: new Date(),
                updatedAt: new Date(),
                meta: null,
                forkedFromRecipeId: null,
                forkedFromRecipeName: null,
              }),
              amounts: [],
            },
          ],
          instructions: [{ instruction: "Mix ingredients" }],
          id: "00000000-0000-4000-8000-000000000004",
          name: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      id: testShortcode("recipe", "RCP-2346"),
      name: "",
      meta: null,

      createdAt: new Date(),
      updatedAt: new Date(),
      forkedFromRecipeId: null,
      forkedFromRecipeName: null,
    },
  );
  let si: SectionIngredient | undefined = recipe.sections[1]?.ingredients[0];
  expect(si).toBeDefined();
  if (!si) return;
  expect(getIngredientName(si)).toEqual("flour-i");
  si = recipe.sections[1]?.ingredients[1];
  expect(si).toBeDefined();
  if (!si) return;
  expect(getIngredientName(si)).toEqual("flour-r");
});

it("nutrition basis requires a serving count and preserves one serving", () => {
  expect(
    getRecipeNutritionBasis(
      servingBasisFixture({ yield: { value: 300, unit: "g" } }),
      "serving",
    ),
  ).toMatchObject({ basis: "whole", factor: 1, hasServing: false });
  expect(
    getRecipeNutritionBasis(
      {
        fields: {
          servings: fieldValueFixture(
            entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
              "servings"
            ],
            1,
          ),
        },
        yield: { value: 300, unit: "g" },
      },
      "serving",
    ),
  ).toMatchObject({ basis: "serving", factor: 1, label: "per serving" });
  expect(
    getRecipeNutritionBasis(
      servingBasisFixture({ yield: { value: 4, unit: "servings" } }),
      "serving",
    ),
  ).toMatchObject({ basis: "serving", factor: 0.25 });
  expect(
    getRecipeNutritionBasis(
      {
        fields: {
          servings: fieldValueFixture(
            entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
              "servings"
            ],
            4,
          ),
        },
      },
      "whole",
    ),
  ).toMatchObject({
    basis: "whole",
    factor: 1,
  });
});

it("keeps per-serving nutrition independent of fractional display rounding", () => {
  const recipeScale = 0.3333;
  const basis = getRecipeNutritionBasis(
    {
      fields: {
        servings: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
            "servings"
          ],
          2,
        ),
      },
    },
    "serving",
    recipeScale,
  );
  expect(150 * recipeScale * basis.factor).toBeCloseTo(75);
  expect(250 * recipeScale * basis.factor).toBeCloseTo(125);
});

/**
 * A unitless yield carries the parser's "whole" sentinel; formatYield drops it
 * so "18 whole" renders as "18". Real units render normally.
 */
it("formatYield drops the bare-count 'whole' unit", () => {
  expect(formatYield({ value: 18, unit: "whole" })).toEqual("18");
  // Real units render normally:
  expect(formatYield({ value: 12, unit: "servings" })).toEqual("12 servings");
});

it("getServingBasis prefers servings and labels yield units", () => {
  const base: RecipeOut = entityReadFixture(
    entityFieldEnvelopeSchemas.recipe.detail,
    {
      fields: {
        images: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape["images"],
          [],
        ),
        dataQuality: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
            "dataQuality"
          ],
          testCompleteDataQuality(),
        ),
      },
      id: testShortcode("recipe", "RCP-2347"),
      name: "Recipe",
      meta: null,

      sections: [],

      createdAt: new Date(),
      updatedAt: new Date(),
      forkedFromRecipeId: null,
      forkedFromRecipeName: null,
    },
  );

  expect(
    getServingBasis({
      ...base,
      fields: {
        ...base.fields,
        servings: fieldValueFixture(
          entityFieldEnvelopeSchemas.recipe.detail.shape.fields.shape[
            "servings"
          ],
          4,
        ),
      },
    }),
  ).toEqual({
    divisor: 4,
    noun: "serving",
  });
  expect(
    getServingBasis(
      servingBasisFixture({ ...base, yield: { value: 12, unit: "churros" } }),
    ),
  ).toEqual({ divisor: 12, noun: "churro" });
  expect(
    getServingBasis(
      servingBasisFixture({ ...base, yield: { value: 2, unit: "whole" } }),
    ),
  ).toEqual({ divisor: 2, noun: "each" });
  expect(
    getServingBasis(
      servingBasisFixture({ ...base, yield: { value: 1, unit: "loaf" } }),
    ),
  ).toBe(null);
});

type RecipeOut = DetailRecordOf<"recipe">;
