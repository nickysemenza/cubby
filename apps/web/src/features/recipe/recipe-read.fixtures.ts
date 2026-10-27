import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import type { RecipeShortcode } from "@cubby/schemas/identifiers";

import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";

const schema = entityFieldEnvelopeSchemas.recipe.detail;
export const emptyRecipeReadFixture = (recipe: {
  id: RecipeShortcode;
  name: string;
}) =>
  entityReadFixture(schema, {
    ...recipe,
    meta: null,
    yield: null,
    notes: null,
    forkedFromRecipeId: null,
    forkedFromRecipeName: null,
    sections: [],
    attachments: [],
    fields: {
      servings: fieldValueFixture(schema.shape.fields.shape.servings, null),
      tags: fieldValueFixture(schema.shape.fields.shape.tags, []),
      images: fieldValueFixture(schema.shape.fields.shape.images, []),
    },
  });

import type { RecipeYield } from "@cubby/schemas/recipe-shared";
export const servingBasisFixture = (input: {
  servings?: number | null;
  yield?: RecipeYield | null;
}) => ({
  yield: input.yield ?? null,
  fields: {
    servings: fieldValueFixture(
      schema.shape.fields.shape.servings,
      input.servings ??
        (input.yield?.unit === "servings" ? input.yield.value : null),
    ),
  },
});
