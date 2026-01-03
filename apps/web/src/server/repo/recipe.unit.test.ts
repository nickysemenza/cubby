import { describe, expect, test } from "vitest";
import { dbRecipeToAPIShallow } from "./recipe";

describe("recipe repository helpers", () => {
  describe("dbRecipeToAPIShallow", () => {
    test("converts website recipe with URL", () => {
      const recipe = {
        id: "recipe-1",
        shortcode: "R-A3F2",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        SourceType: "Website" as const,
        SourceData: "https://example.com/recipe",
        yield: null,
        servings: null,
        tags: null,
      };

      const result = dbRecipeToAPIShallow(recipe);

      expect(result).toEqual({
        id: "recipe-1",
        shortcode: "R-A3F2",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        yield: null,
        servings: null,
        tags: null,
        meta: {
          url: "https://example.com/recipe",
        },
      });
    });

    test("converts non-website recipe without URL", () => {
      const recipe = {
        id: "recipe-1",
        shortcode: "R-X7K9",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        SourceType: "Other" as const,
        SourceData: "some data",
        yield: null,
        servings: null,
        tags: null,
      };

      const result = dbRecipeToAPIShallow(recipe);

      expect(result).toEqual({
        id: "recipe-1",
        shortcode: "R-X7K9",
        name: "Test Recipe",
        createdAt: new Date("2023-01-01"),
        updatedAt: new Date("2023-01-02"),
        deletedAt: null,
        yield: null,
        servings: null,
        tags: null,
        meta: {
          url: null,
        },
      });
    });
  });
});
