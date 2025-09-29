import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { upsertRecipeFromCompact } from "./compactrecipe";
import { type ParsedCompactRecipe } from "~/codec/codec";
import { unsafeProjectId, type ProjectId } from "~/schemas/identifiers";

describe("upsertRecipeFromCompact", () => {
  let prisma: PrismaClient;
  let projectId: ProjectId;
  beforeEach(async () => {
    const { prisma: db, projectId: pId, teardown } = await buildTestDB();
    prisma = db;
    projectId = unsafeProjectId(pId);

    return teardown;
  });

  const mockRecipe: ParsedCompactRecipe = {
    name: "Test Recipe",
    meta: {
      url: "https://example.com/recipe",
    },
    sections: [
      {
        instructions: ["Mix ingredients", "Bake for 30 minutes"],
        ingredients: [
          {
            name: "flour",
            amounts: [{ value: 2, unit: "cups" }],
          },
          {
            name: "sugar",
            amounts: [{ value: 1, unit: "cup" }],
          },
        ],
      },
    ],
  };

  const mockRecipeUpdated: ParsedCompactRecipe = {
    name: "Test Recipe", // Same name
    meta: {
      url: "https://example.com/recipe-updated",
    },
    sections: [
      {
        instructions: ["Mix ingredients well", "Bake for 35 minutes"], // Updated instructions
        ingredients: [
          {
            name: "flour",
            amounts: [{ value: 3, unit: "cups" }], // Updated amount
          },
          {
            name: "butter", // Different ingredient
            amounts: [{ value: 0.5, unit: "cup" }],
          },
        ],
      },
      {
        instructions: ["Sprinkle on top"],
        ingredients: [
          {
            name: "cinnamon",
            amounts: [{ value: 1, unit: "tsp" }],
          },
        ],
      },
    ],
  };

  it("creates a new recipe when it doesn't exist", async () => {
    const result = await upsertRecipeFromCompact(mockRecipe, prisma, projectId);

    expect(result.id).toBeDefined();

    // Verify recipe was created
    const recipe = await prisma.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe",
        },
      },
      include: {
        sections: {
          include: {
            ingredients: true,
          },
        },
      },
    });

    expect(recipe).toBeTruthy();
    expect(recipe!.name).toBe("Test Recipe");
    expect(recipe!.SourceType).toBe("Website");
    expect(recipe!.SourceData).toBe("https://example.com/recipe");
    expect(recipe!.sections).toHaveLength(1);
    expect(recipe!.sections[0]!.ingredients).toHaveLength(2);
  });

  it("updates an existing recipe when it already exists", async () => {
    // First, create the recipe
    const firstResult = await upsertRecipeFromCompact(
      mockRecipe,
      prisma,
      projectId,
    );

    // Verify initial state
    const initialRecipe = await prisma.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe",
        },
      },
      include: {
        sections: {
          include: {
            ingredients: true,
          },
        },
      },
    });

    expect(initialRecipe!.sections).toHaveLength(1);
    expect(initialRecipe!.sections[0]!.ingredients).toHaveLength(2);

    // Now update with different data
    const secondResult = await upsertRecipeFromCompact(
      mockRecipeUpdated,
      prisma,
      projectId,
    );

    // Should return same recipe ID (updated, not created new)
    expect(secondResult.id).toBe(firstResult.id);

    // Verify the recipe was updated
    const updatedRecipe = await prisma.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe",
        },
      },
      include: {
        sections: {
          include: {
            ingredients: true,
          },
        },
      },
    });

    expect(updatedRecipe!.id).toBe(firstResult.id); // Same recipe
    expect(updatedRecipe!.SourceData).toBe(
      "https://example.com/recipe-updated",
    ); // Updated URL
    expect(updatedRecipe!.sections).toHaveLength(2); // Now has 2 sections

    // Check first section was updated (sections should be in order)
    const firstSection = updatedRecipe!.sections[0];
    expect(firstSection!.ingredients).toHaveLength(2); // flour + butter (sugar removed)

    // Check new section was added
    const secondSection = updatedRecipe!.sections[1];
    expect(secondSection).toBeTruthy();
    expect(secondSection!.ingredients).toHaveLength(1); // cinnamon
  });

  it("handles multiple upserts correctly (back-to-back npm run load-data scenario)", async () => {
    // This tests the exact scenario mentioned - running load-data multiple times
    const firstRun = await upsertRecipeFromCompact(
      mockRecipe,
      prisma,
      projectId,
    );
    const secondRun = await upsertRecipeFromCompact(
      mockRecipe,
      prisma,
      projectId,
    ); // Same recipe
    const thirdRun = await upsertRecipeFromCompact(
      mockRecipe,
      prisma,
      projectId,
    ); // Same recipe again

    // All should return the same recipe ID
    expect(secondRun.id).toBe(firstRun.id);
    expect(thirdRun.id).toBe(firstRun.id);

    // Should only be one recipe in the database
    const allRecipes = await prisma.recipe.findMany({
      where: {
        projectId: projectId,
        name: "Test Recipe",
      },
    });

    expect(allRecipes).toHaveLength(1);
  });

  it("properly cleans up old sections and ingredients", async () => {
    // Create recipe with 2 sections
    await upsertRecipeFromCompact(mockRecipeUpdated, prisma, projectId);

    const beforeUpdate = await prisma.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe",
        },
      },
      include: { sections: { include: { ingredients: true } } },
    });

    const sectionCountBefore = beforeUpdate!.sections.length;
    const ingredientCountBefore = beforeUpdate!.sections.reduce(
      (total, section) => total + section.ingredients.length,
      0,
    );

    // Update to recipe with 1 section
    await upsertRecipeFromCompact(mockRecipe, prisma, projectId);

    const afterUpdate = await prisma.recipe.findUnique({
      where: {
        projectId_name: {
          projectId: projectId,
          name: "Test Recipe",
        },
      },
      include: { sections: { include: { ingredients: true } } },
    });

    const sectionCountAfter = afterUpdate!.sections.length;
    const ingredientCountAfter = afterUpdate!.sections.reduce(
      (total, section) => total + section.ingredients.length,
      0,
    );

    // Verify data was properly cleaned up and replaced
    expect(sectionCountAfter).toBe(1);
    expect(sectionCountAfter).toBeLessThan(sectionCountBefore);
    expect(ingredientCountAfter).toBe(2);
    expect(ingredientCountAfter).toBeLessThan(ingredientCountBefore);

    // Verify no orphaned records exist
    const orphanedSections = await prisma.recipeSection.findMany({
      where: { recipeId: { not: afterUpdate!.id } },
    });
    expect(orphanedSections).toHaveLength(0);
  });
});
