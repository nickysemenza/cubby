import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { describe, expect, it } from "vitest";

import {
  importRecipeUrl,
  normalizeImportRecipe,
} from "./import-recipe-normalizer";

const baseRecipe = (recipe: Partial<ImportRecipe> = {}): ImportRecipe => ({
  meta: {
    title: "Pancakes",
    ...recipe.meta,
  },
  sections: [
    {
      name: " A ",
      ingredients: ["1 cup flour"],
      instructions: ["Mix"],
    },
  ],
  references: [],
  ...recipe,
});

describe("normalizeImportRecipe", () => {
  it("uses structured scraper yield and explicit servings", () => {
    const normalized = normalizeImportRecipe(
      baseRecipe({
        meta: {
          title: "Pancakes",
          recipe_yield: { value: 12, unit: "pancakes" },
          description: "Weekend food.",
          notes: ["Keep warm"],
        },
        servings: 4,
        url: "https://example.com/pancakes",
      }),
      ["breakfast"],
    );

    expect(normalized).toMatchObject({
      name: "Pancakes",
      meta: { url: "https://example.com/pancakes" },
      yield: { value: 12, unit: "pancakes" },
      servings: 4,
      tags: ["breakfast"],
      notes: "Weekend food.\n\n- Keep warm",
      sections: [
        {
          name: null,
          ingredients: ["1 cup flour"],
          instructions: [{ instruction: "Mix" }],
        },
      ],
    });
  });

  it("parses freeform yield and derives servings", () => {
    const normalized = normalizeImportRecipe(
      baseRecipe({
        meta: { title: "Soup", recipe_yield: "Serves 6" },
      }),
    );

    expect(normalized.servings).toBe(6);
    expect(normalized.tags).toBeNull();
  });

  it("filters synthetic cookbook urls", () => {
    expect(importRecipeUrl("Book.epub#chapter-1")).toBeNull();
    expect(importRecipeUrl(undefined)).toBeNull();
    expect(importRecipeUrl("http://example.com")).toBe("http://example.com");
  });
});
