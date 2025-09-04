import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { recipeRouter } from "./recipe";
import { createCallerFactory } from "../trpc";
import { findOrCreateIngredient } from "~/server/repo/ingredient";

let prisma: PrismaClient;

describe("recipe router", () => {
  beforeEach(async () => {
    // Get a isolated test database for each test
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });

  it("should create and retrieve a recipe", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a test ingredient first
    const ingredient = await findOrCreateIngredient(prisma, "flour");

    // Create a test recipe
    const recipeData = {
      name: "Test Recipe",
      meta: {
        url: "https://example.com/recipe",
      },
      sections: [
        {
          name: "Main Section",
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: ingredient.id,
              recipeId: null,
              amounts: [
                {
                  value: 2,
                  unit: "cups",
                },
              ],
            },
          ],
          instructions: [
            {
              instruction: "Mix ingredients",
            },
          ],
        },
      ],
      images: [],
    };

    // Create the recipe
    const createdRecipe = await caller.create(recipeData);

    // Verify the recipe was created correctly
    expect(createdRecipe.id).toBeDefined();

    // Retrieve the recipe by ID
    const retrievedRecipe = await caller.get({ id: createdRecipe.id });

    // Verify retrieved recipe matches created recipe
    expect(retrievedRecipe.id).toEqual(createdRecipe.id);
    expect(retrievedRecipe.name).toEqual(recipeData.name);
    expect(retrievedRecipe.meta?.url).toEqual(recipeData.meta.url);
    expect(retrievedRecipe.sections).toHaveLength(1);
    expect(retrievedRecipe.sections[0].name).toEqual("Main Section");
    expect(retrievedRecipe.sections[0].ingredients).toHaveLength(1);
    expect(retrievedRecipe.sections[0].ingredients[0].type).toEqual(
      "ingredient",
    );
    expect(retrievedRecipe.sections[0].ingredients[0].amounts).toHaveLength(1);
    expect(retrievedRecipe.sections[0].ingredients[0].amounts[0].value).toEqual(
      2,
    );
    expect(retrievedRecipe.sections[0].ingredients[0].amounts[0].unit).toEqual(
      "cups",
    );
    expect(retrievedRecipe.sections[0].instructions).toHaveLength(1);
    expect(retrievedRecipe.sections[0].instructions[0].instruction).toEqual(
      "Mix ingredients",
    );
  });

  it("should list recipes with filtering", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create test ingredients
    const flour = await findOrCreateIngredient(prisma, "flour");
    const sugar = await findOrCreateIngredient(prisma, "sugar");

    // Create multiple test recipes
    const recipeData1 = {
      name: "Chocolate Cake",
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: flour.id,
              recipeId: null,
              amounts: [{ value: 2, unit: "cups" }],
            },
          ],
          instructions: [{ instruction: "Mix well" }],
        },
      ],
      images: [],
    };

    const recipeData2 = {
      name: "Sugar Cookies",
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: sugar.id,
              recipeId: null,
              amounts: [{ value: 1, unit: "cup" }],
            },
          ],
          instructions: [{ instruction: "Bake until golden" }],
        },
      ],
      images: [],
    };

    const recipeData3 = {
      name: "Chocolate Chip Cookies",
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: flour.id,
              recipeId: null,
              amounts: [{ value: 1.5, unit: "cups" }],
            },
          ],
          instructions: [{ instruction: "Drop on baking sheet" }],
        },
      ],
      images: [],
    };

    // Create the recipes
    await caller.create(recipeData1);
    await caller.create(recipeData2);
    await caller.create(recipeData3);

    // Test listing without filters
    const allRecipes = await caller.list({
      filters: {},
      pagination: { pageSize: 10, pageIndex: 0 },
      sort: { orderBy: "name", direction: "asc" },
    });

    // Should return all recipes
    expect(allRecipes.items.length).toEqual(3);
    expect(allRecipes.meta.totalCount).toEqual(3);

    // Test filtering by name
    const chocolateRecipes = await caller.list({
      filters: { nameFilter: "Chocolate" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only recipes with "Chocolate" in name
    expect(chocolateRecipes.items.length).toEqual(2);
    expect(chocolateRecipes.meta.totalCount).toEqual(2);
    expect(chocolateRecipes.items[0].name).toContain("Chocolate");
    expect(chocolateRecipes.items[1].name).toContain("Chocolate");

    // Test filtering with no matches
    const pizzaRecipes = await caller.list({
      filters: { nameFilter: "Pizza" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return no recipes
    expect(pizzaRecipes.items.length).toEqual(0);
    expect(pizzaRecipes.meta.totalCount).toEqual(0);
  });

  it("should update a recipe", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create test ingredients
    const flour = await findOrCreateIngredient(prisma, "flour");
    const butter = await findOrCreateIngredient(prisma, "butter");

    // Create a test recipe
    const recipeData = {
      name: "Original Recipe",
      meta: null,
      sections: [
        {
          name: "Original Section",
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: flour.id,
              recipeId: null,
              amounts: [{ value: 1, unit: "cup" }],
            },
          ],
          instructions: [{ instruction: "Original instruction" }],
        },
      ],
      images: [],
    };

    // Create the recipe
    const createdRecipe = await caller.create(recipeData);

    // Update the recipe
    const updatedRecipe = await caller.update({
      id: createdRecipe.id,
      data: {
        name: "Updated Recipe",
        meta: {
          url: "https://example.com/updated",
        },
        sections: [
          {
            name: "Updated Section",
            ingredients: [
              {
                type: "ingredient" as const,
                ingredientId: butter.id,
                recipeId: null,
                amounts: [{ value: 0.5, unit: "cup" }],
              },
            ],
            instructions: [{ instruction: "Updated instruction" }],
          },
        ],
      },
    });

    // Verify the recipe was updated correctly
    expect(updatedRecipe.id).toEqual(createdRecipe.id);

    // Retrieve the updated recipe
    const retrievedRecipe = await caller.get({ id: createdRecipe.id });

    // Verify updates were applied
    expect(retrievedRecipe.name).toEqual("Updated Recipe");
    expect(retrievedRecipe.meta?.url).toEqual("https://example.com/updated");
    expect(retrievedRecipe.sections).toHaveLength(1);
    expect(retrievedRecipe.sections[0].name).toEqual("Updated Section");
    expect(retrievedRecipe.sections[0].instructions[0].instruction).toEqual(
      "Updated instruction",
    );
    expect(retrievedRecipe.sections[0].ingredients[0].amounts[0].value).toEqual(
      0.5,
    );
  });

  it("should handle partial updates correctly", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a test ingredient
    const flour = await findOrCreateIngredient(prisma, "flour");

    // Create a test recipe
    const recipeData = {
      name: "Test Recipe",
      meta: {
        url: "https://example.com/original",
      },
      sections: [
        {
          name: "Test Section",
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: flour.id,
              recipeId: null,
              amounts: [{ value: 2, unit: "cups" }],
            },
          ],
          instructions: [{ instruction: "Test instruction" }],
        },
      ],
      images: [],
    };

    // Create the recipe
    const createdRecipe = await caller.create(recipeData);

    // Update only the name
    const updatedRecipe = await caller.update({
      id: createdRecipe.id,
      data: {
        name: "Updated Name Only",
      },
    });

    // Verify only the name was updated
    expect(updatedRecipe.id).toEqual(createdRecipe.id);

    // Retrieve the recipe to verify other fields unchanged
    const retrievedRecipe = await caller.get({ id: createdRecipe.id });

    expect(retrievedRecipe.name).toEqual("Updated Name Only");
    expect(retrievedRecipe.meta?.url).toEqual("https://example.com/original"); // Unchanged
    expect(retrievedRecipe.sections).toHaveLength(1);
    expect(retrievedRecipe.sections[0].name).toEqual("Test Section"); // Unchanged
  });

  it("should throw error when retrieving recipe with invalid ID", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Try to retrieve a recipe with a non-existent ID
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    await expect(caller.get({ id: nonExistentId })).rejects.toThrow(
      "Recipe not found",
    );
  });

  it("should create recipe with recipe ingredient (nested recipe)", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create an ingredient for the base recipe
    const flour = await findOrCreateIngredient(prisma, "flour");

    // Create a base recipe to be used as ingredient
    const baseRecipeData = {
      name: "Base Recipe",
      meta: null,
      sections: [
        {
          ingredients: [
            {
              type: "ingredient" as const,
              ingredientId: flour.id,
              recipeId: null,
              amounts: [{ value: 1, unit: "cup" }],
            },
          ],
          instructions: [{ instruction: "Mix flour" }],
        },
      ],
      images: [],
    };

    const baseRecipe = await caller.create(baseRecipeData);

    // Create a recipe that uses the base recipe as an ingredient
    const complexRecipeData = {
      name: "Complex Recipe",
      meta: null,
      sections: [
        {
          name: "Complex Section",
          ingredients: [
            {
              type: "recipe" as const,
              recipeId: baseRecipe.id,
              ingredientId: null,
              amounts: [{ value: 2, unit: "portions" }],
            },
          ],
          instructions: [{ instruction: "Use base recipe twice" }],
        },
      ],
      images: [],
    };

    // Create the complex recipe
    const complexRecipe = await caller.create(complexRecipeData);

    // Retrieve and verify the complex recipe
    const retrievedRecipe = await caller.get({ id: complexRecipe.id });

    expect(retrievedRecipe.sections[0].ingredients).toHaveLength(1);
    expect(retrievedRecipe.sections[0].ingredients[0].type).toEqual("recipe");
    expect(retrievedRecipe.sections[0].ingredients[0].recipe?.name).toEqual(
      "Base Recipe",
    );
    expect(retrievedRecipe.sections[0].ingredients[0].amounts[0].value).toEqual(
      2,
    );
    expect(retrievedRecipe.sections[0].ingredients[0].amounts[0].unit).toEqual(
      "portions",
    );
  });

  it("should insert compact recipe", async () => {
    // Create a test caller for the recipe router
    const createCaller = createCallerFactory(recipeRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a compact recipe (simplified format)
    const compactRecipeData = {
      name: "Compact Recipe",
      sections: [
        {
          instructions: ["Mix well", "Bake for 30 minutes"],
          ingredients: ["2 cups flour", "1 tsp salt"],
        },
      ],
    };

    // Insert the compact recipe
    const insertedRecipe = await caller.insertCompact(compactRecipeData);

    // Verify the recipe was created
    expect(insertedRecipe.id).toBeDefined();

    // Retrieve and verify the recipe
    const retrievedRecipe = await caller.get({ id: insertedRecipe.id });

    expect(retrievedRecipe.name).toEqual("Compact Recipe");
    expect(retrievedRecipe.sections).toHaveLength(1);
    expect(retrievedRecipe.sections[0].instructions).toHaveLength(2);
  });
});
