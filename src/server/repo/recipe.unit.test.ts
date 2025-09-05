import { describe, expect, test } from "vitest";
import { dbRecipeToAPIShallow } from "./recipe";
import { RecipeSource } from "@prisma/client";

describe("recipe repository helpers", () => {
  describe("dbRecipeToAPIShallow", () => {
    test("converts website recipe with URL", () => {
      const recipe = {
        id: "recipe-1",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        SourceType: RecipeSource.Website,
        SourceData: "https://example.com/recipe",
      };

      const result = dbRecipeToAPIShallow(recipe);

      expect(result).toEqual({
        id: "recipe-1",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        meta: {
          url: "https://example.com/recipe",
        },
      });
    });

    test("converts non-website recipe without URL", () => {
      const recipe = {
        id: "recipe-1",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        SourceType: RecipeSource.Other,
        SourceData: "some data",
      };

      const result = dbRecipeToAPIShallow(recipe);

      expect(result).toEqual({
        id: "recipe-1",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        meta: {
          url: null,
        },
      });
    });
  });
});
