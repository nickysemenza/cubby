import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import {
  ingredientOut,
  ingredientWithFoodOut,
  ingredientListItemOut,
  ingredientWithFoodLeanOut,
  enrichmentRowOut,
  ingredientWithFoodMcpEntityOut,
  ingredientListItemMcpEntityOut,
} from "@cubby/schemas/ingredient";
import { rawProductOutput } from "@cubby/schemas/product-raw-read";
import {
  recipeOut,
  recipeTopLevel,
  recipeListItemOut,
  recipeGraphOut,
  recipeMcpEntityOut,
  recipeWithSideEffectsOut,
  recipesUsingIngredientOut,
} from "@cubby/schemas/recipe";
import { testShortcode } from "@cubby/schemas/testing";
import { foodSummary } from "@cubby/usda";
import { describe, expect, it } from "vitest";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { mock } from "~/lib/test/mock-schema";

import {
  entitySummaryResultSchema,
  projectEntityResult,
  slimUsdaFood,
  slimUsdaFoodListItem,
} from "./mcp-projections";

describe("canonical Product MCP attachments", () => {
  it("retains the published image evidence without reconstructing a second Product shape", () => {
    const rawAttachment = mock(rawProductOutput.shape.images.element, {
      seed: 1,
      overrides: {
        id: testShortcode("image", "IMG-EXAMPLE"),
        url: "https://images.example.test/item.jpg",
        sourcePageUrl: "https://catalog.example.test/item",
        purpose: null,
      },
    });
    const image = mock(entityFieldEnvelopeSchemas.image.output, { seed: 3 });
    const attachment = {
      ...rawAttachment,
      fields: {
        ...image.fields,
        url: fieldValueFixture(
          entityFieldEnvelopeSchemas.image.output.shape.fields.shape.url,
          rawAttachment.url,
        ),
      },
    };
    const schema = entityFieldEnvelopeSchemas.product.mcpDetail;
    const product = mock(schema, { seed: 2 });
    const result = schema.parse({
      ...product,
      fields: {
        ...product.fields,
        images: {
          current: {
            assignment: null,
            controls: { kind: "readonly", reason: "computed" },
          },
          result: {
            kind: "cached",
            computedAt: "2026-10-01T00:00:00Z",
            freshness: "stale",
            decision: {
              outcome: { kind: "value", value: [attachment] },
              provenance: { kind: "computed" },
            },
          },
          work: { kind: "idle" },
        },
      },
    });
    expect(result.fields.images.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
      decision: {
        outcome: {
          kind: "value",
          value: [
            expect.objectContaining({
              id: attachment.id,
              sourcePageUrl: attachment.sourcePageUrl,
            }),
          ],
        },
      },
    });
    expect(result).not.toHaveProperty("images");
  });
});

describe("data-quality coverage projection", () => {
  // coverageFor is structural (any item carrying `dataQuality`), not a
  // product-only branch, so a non-product scored entity (purchase here)
  // retains its coverage when merge returns expanded detail.
  it("projects coverage for a non-product scored entity's merge result", () => {
    const result = projectEntityResult(
      { resultDetail: "summary" },
      {
        action: "merge",
        entity: "purchase",
        item: {
          id: "PUR-2ABC",
          displayName: "Synthetic purchase",
          dataQuality: {
            status: "needs_data",
            gaps: [
              { check: "order_id", kind: "missing" },
              { check: "paperwork_mismatch", kind: "defect" },
            ],
          },
        },
      },
    );

    expect(result).toMatchObject({
      item: {
        id: "PUR-2ABC",
        name: "Synthetic purchase",
        coverage: {
          status: "needs_data",
          missingChecks: ["order_id"],
          defectChecks: ["paperwork_mismatch"],
        },
      },
    });
  });

  it("omits coverage for entities with no dataQuality block", () => {
    const result = projectEntityResult(
      { resultDetail: "summary" },
      {
        action: "get",
        entity: "cookbook",
        item: { id: "CBK-2ABC", name: "Synthetic book" },
      },
    );

    expect(result).toMatchObject({ item: { id: "CBK-2ABC" } });
    const parsed = entitySummaryResultSchema.parse(result);
    expect(parsed.item?.coverage).toBeUndefined();
  });
});

it("keeps every public Ingredient projection on the canonical field contract", () => {
  for (const schema of [
    ingredientOut,
    ingredientWithFoodOut,
    ingredientListItemOut,
    ingredientWithFoodLeanOut,
    enrichmentRowOut,
    ingredientWithFoodMcpEntityOut,
    ingredientListItemMcpEntityOut,
  ]) {
    expect(schema.shape).toHaveProperty("fields");
    expect(schema.shape).not.toHaveProperty("dataQuality");
    expect(schema.shape).not.toHaveProperty("derived");
  }
  for (const schema of [
    ingredientWithFoodOut,
    ingredientListItemOut,
    ingredientWithFoodLeanOut,
    enrichmentRowOut,
    ingredientWithFoodMcpEntityOut,
    ingredientListItemMcpEntityOut,
  ]) {
    expect(schema.shape.product.element.shape).toHaveProperty("fields");
    expect(schema.shape.product.element.shape).not.toHaveProperty("price");
    expect(schema.shape.product.element.shape).not.toHaveProperty(
      "fieldResolutions",
    );
  }
});

it("keeps public Recipe and section projections on one field contract", () => {
  for (const schema of [
    recipeOut,
    recipeTopLevel,
    recipeListItemOut,
    recipeGraphOut,
    recipeMcpEntityOut,
    recipeWithSideEffectsOut,
  ]) {
    expect(schema.shape).toHaveProperty("fields");
    expect(schema.shape).not.toHaveProperty("servings");
    expect(schema.shape).not.toHaveProperty("fieldResolutions");
  }
  for (const schema of [recipeOut, recipeGraphOut, recipeMcpEntityOut]) {
    const subrecipe =
      schema.shape.sections.element.shape.ingredients.element.options[1].shape
        .recipe;
    expect(subrecipe.shape).toHaveProperty("fields");
    expect(subrecipe.shape).not.toHaveProperty("servings");
    expect(subrecipe.shape).not.toHaveProperty("sections");
  }
  expect(recipeMcpEntityOut.shape.sections.element.shape).not.toHaveProperty(
    "id",
  );
});

it("keeps MCP recipe usage references compact while preserving line evidence", () => {
  const result = {
    ingredientId: testShortcode("ingredient", "ING-USAGE"),
    count: 1,
    recipes: [
      {
        id: testShortcode("recipe", "RCP-USAGE"),
        name: "Synthetic pastry",
        usages: [
          {
            lineId: "00000000-0000-4000-8000-000000000010",
            sectionName: "Assembly",
            amounts: [{ value: 1, unit: "cup" }],
            rawLine: "1 cup synthetic flour",
            modifier: "sifted",
          },
        ],
      },
    ],
  };
  expect(recipesUsingIngredientOut.parse(result)).toEqual(result);
});

describe("USDA linked Product compact references", () => {
  it("projects canonical Products to ordinary identity references", () => {
    const product = mock(entityFieldEnvelopeSchemas.product.output, {
      seed: 3,
      overrides: {
        id: testShortcode("product", "PRD-EXAMPLE"),
        name: "Synthetic linked food",
      },
    });
    const food = {
      ...mock(foodSummary, { seed: 4 }),
      linkedProducts: [product],
    };
    const references = [{ id: product.id, name: product.name }];
    expect(slimUsdaFood(food).linkedProducts).toEqual(references);
    expect(slimUsdaFoodListItem(food).linkedProducts).toEqual(references);
  });
});
