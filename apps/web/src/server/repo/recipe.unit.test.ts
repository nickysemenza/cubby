import {
  unsafeIngredientId,
  unsafeIngredientShortcode,
  unsafeRecipeId,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import {
  recipeGraphOut,
  recipeListItemOut,
  recipeOut,
  recipeUsageOut,
} from "@cubby/schemas/recipe";
import { describe, expect, it } from "vitest";
import { computeRecipeUsages, dbRecipeToAPIShallow } from "./recipe";
import { dbRecipeToAPI, dbRecipeToAPIGraph } from "./recipe/helpers";
import type { RecipeDeepDB, RecipeGraphDB } from "./recipe/internal-types";

const RECIPE_ID = unsafeRecipeId("123e4567-e89b-12d3-a456-426614174000");
const SUB_RECIPE_ID = unsafeRecipeId("223e4567-e89b-12d3-a456-426614174000");
const INGREDIENT_ID = unsafeIngredientId(
  "323e4567-e89b-12d3-a456-426614174000",
);
const SECTION_ID = "423e4567-e89b-12d3-a456-426614174000";
const INGREDIENT_ROW_ID = "523e4567-e89b-12d3-a456-426614174000";
const RECIPE_ROW_ID = "623e4567-e89b-12d3-a456-426614174000";
const IMAGE_ID = "723e4567-e89b-12d3-a456-426614174000";
const DELETED_IMAGE_ID = "823e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = new Date("2023-01-01T00:00:00.000Z");
const UPDATED_AT = new Date("2023-01-02T00:00:00.000Z");
const DELETED_AT = new Date("2023-01-03T00:00:00.000Z");

const baseRecipe = {
  id: RECIPE_ID,
  shortcode: "RCP-A3F2",
  name: "Test Recipe",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  SourceType: "Website" as const,
  SourceData: "https://example.com/recipe",
  cookbookId: null,
  yield: null,
  servings: null,
  tags: null,
  notes: null,
  totals: null,
  totalsComputedAt: null,
};

const subRecipe = {
  ...baseRecipe,
  id: SUB_RECIPE_ID,
  shortcode: "RCP-SUB7",
  name: "Sub Recipe",
  SourceType: "Other" as const,
  SourceData: null,
};

const baseIngredient = {
  id: INGREDIENT_ID,
  shortcode: "ING-TEST",
  name: "Flour",
  aliases: ["all-purpose flour"],
  naKinds: [],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: DELETED_AT,
  recipeId: null,
};

const baseIngredientRelation = {
  ...baseIngredient,
  recipe: null,
};

const image = {
  id: IMAGE_ID,
  url: "https://example.com/recipe.jpg",
  key: "recipe.jpg",
  filename: "recipe.jpg",
  size: 100,
  contentType: "image/jpeg",
  status: "UPLOADED" as const,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  deletedAt: null,
};

const deletedImage = {
  ...image,
  id: DELETED_IMAGE_ID,
  url: "https://example.com/deleted.jpg",
};

const fullRecipeRow = {
  ...baseRecipe,
  images: [
    { image, deletedAt: null },
    { image: deletedImage, deletedAt: DELETED_AT },
  ],
  sections: [
    {
      id: SECTION_ID,
      recipeId: RECIPE_ID,
      name: "Dough",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      deletedAt: null,
      sortOrder: 0,
      instructions: [{ text: "Mix." }],
      ingredients: [
        {
          id: INGREDIENT_ROW_ID,
          recipeSectionId: SECTION_ID,
          ingredientId: INGREDIENT_ID,
          amounts: [{ value: 2, unit: "cup" }],
          rawLine: "2 cups flour",
          modifier: null,
          sortOrder: 0,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          ingredient: baseIngredientRelation,
        },
        {
          id: RECIPE_ROW_ID,
          recipeSectionId: SECTION_ID,
          ingredientId: INGREDIENT_ID,
          amounts: [{ value: 1, unit: "each" }],
          rawLine: "1 recipe sub",
          modifier: null,
          sortOrder: 1,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          ingredient: {
            ...baseIngredient,
            recipeId: SUB_RECIPE_ID,
            recipe: subRecipe,
          },
        },
      ],
    },
  ],
} satisfies RecipeDeepDB;

// dbRecipeToAPIShallow produces the shared topLevel+totals base that
// dbRecipeToAPI/dbRecipeToAPIGraph/dbRecipeToListAPI each layer their own
// remaining fields on top of — it deliberately omits the list-only
// `mealCount`/`sectionCount`/`images` extras (see dbRecipeToListAPI), so
// validate its output against recipeListItemOut minus those three.
const recipeShallowOut = recipeListItemOut.omit({
  mealCount: true,
  sectionCount: true,
  images: true,
});

describe("recipe repository helpers", () => {
  describe("dbRecipeToAPIShallow", () => {
    it("converts website recipe with URL without leaking DB-only fields", () => {
      const result = dbRecipeToAPIShallow(baseRecipe);

      expect(result).toEqual({
        id: "RCP-A3F2",
        name: "Test Recipe",
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        yield: null,
        servings: null,
        tags: null,
        notes: null,
        totals: null,
        meta: {
          url: "https://example.com/recipe",
        },
        source: {
          type: "website",
          url: "https://example.com/recipe",
        },
      });
      expect(result.id).toBe("RCP-A3F2");
      expect(result).not.toHaveProperty("deletedAt");
      expect(result).not.toHaveProperty("totalsComputedAt");
      expect(result).not.toHaveProperty("SourceType");
      expect(result).not.toHaveProperty("SourceData");
      expect(recipeShallowOut.parse(result)).toEqual(result);
    });

    it("converts non-website recipe without URL", () => {
      const result = dbRecipeToAPIShallow({
        ...baseRecipe,
        SourceType: "Other",
        SourceData: "some data",
      });

      expect(result).toMatchObject({
        id: unsafeRecipeShortcode("RCP-A3F2"),
        name: "Test Recipe",
        meta: { url: null },
        source: { type: "other" },
      });
      expect(recipeShallowOut.parse(result)).toEqual(result);
    });
  });

  it("maps full recipe detail rows exactly and filters soft-deleted relations", () => {
    const result = dbRecipeToAPI(fullRecipeRow);

    expect(result).toMatchObject({
      id: unsafeRecipeShortcode("RCP-A3F2"),
      name: "Test Recipe",
      images: [{ id: IMAGE_ID, url: "https://example.com/recipe.jpg" }],
      sections: [
        {
          id: SECTION_ID,
          name: "Dough",
          instructions: [{ instruction: "Mix." }],
          ingredients: [
            {
              id: INGREDIENT_ROW_ID,
              type: "ingredient",
              recipe: null,
              ingredient: {
                id: unsafeIngredientShortcode("ING-TEST"),
                name: "Flour",
                aliases: ["all-purpose flour"],
              },
            },
            {
              id: RECIPE_ROW_ID,
              type: "recipe",
              ingredient: null,
              recipe: {
                id: unsafeRecipeShortcode("RCP-SUB7"),
                name: "Sub Recipe",
              },
            },
          ],
        },
      ],
    });
    expect(result.id).toBe("RCP-A3F2");
    expect(result).not.toHaveProperty("deletedAt");
    expect(result).not.toHaveProperty("SourceType");
    expect(result.images).toHaveLength(1);
    expect(result.sections[0]).not.toHaveProperty("recipeId");
    expect(result.sections[0]).not.toHaveProperty("sortOrder");
    expect(result.sections[0]?.ingredients[0]).not.toHaveProperty(
      "recipeSectionId",
    );
    expect(result.sections[0]?.ingredients[0]).not.toHaveProperty(
      "ingredientId",
    );
    expect(result.sections[0]?.ingredients[0]?.ingredient).not.toHaveProperty(
      "deletedAt",
    );
    expect(recipeOut.parse(result)).toEqual(result);
  });

  it("maps graph rows without media", () => {
    const { images: _images, ...graphRow } = fullRecipeRow;
    const result = dbRecipeToAPIGraph(graphRow satisfies RecipeGraphDB);

    expect(result).not.toHaveProperty("images");
    expect(result.sections).toHaveLength(1);
    expect(recipeGraphOut.parse(result)).toEqual(result);
  });

  it("maps recipe usage recipe refs without list-only totals", () => {
    const { recipeUsages, appearsInRecipes } = computeRecipeUsages([
      {
        id: INGREDIENT_ROW_ID,
        recipeSectionId: SECTION_ID,
        ingredientId: INGREDIENT_ID,
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups flour",
        modifier: null,
        sortOrder: 0,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        deletedAt: null,
        recipeSection: {
          id: SECTION_ID,
          recipeId: RECIPE_ID,
          name: "Dough",
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          deletedAt: null,
          sortOrder: 0,
          instructions: [],
          recipe: { ...baseRecipe, deletedAt: null },
        },
      },
    ]);

    expect(recipeUsages).toHaveLength(1);
    expect(appearsInRecipes).toHaveLength(1);
    expect(recipeUsages[0]?.recipe).not.toHaveProperty("totals");
    expect(appearsInRecipes[0]).not.toHaveProperty("totals");
    expect(recipeUsages[0]?.recipe.id).toBeDefined();
    expect(recipeUsageOut.parse(recipeUsages[0])).toEqual(recipeUsages[0]);
  });
});
