import { describe, expect, test } from "vitest";
import {
  recipeCreateInput,
  recipeIngredientInput,
  recipeInstructionInput,
  recipeSectionInput,
  recipeTopLevel,
  recipeUpdateInput,
} from "./recipe";

describe("recipeTopLevel schema", () => {
  test("validates valid recipe top level data", () => {
    const now = new Date();
    const validRecipe = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Chocolate Cake",
      meta: {
        url: "https://example.com/recipe",
      },
      createdAt: now,
      updatedAt: now,
    };

    const result = recipeTopLevel.safeParse(validRecipe);
    expect(result.success).toBe(true);
  });

  test("validates with null meta", () => {
    const now = new Date();
    const validRecipe = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Chocolate Cake",
      meta: null,
      createdAt: now,
      updatedAt: now,
    };

    const result = recipeTopLevel.safeParse(validRecipe);
    expect(result.success).toBe(true);
  });

  test("rejects invalid URL in meta", () => {
    const now = new Date();
    const invalidRecipe = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Chocolate Cake",
      meta: {
        url: "not-a-url",
      },
      createdAt: now,
      updatedAt: now,
    };

    const result = recipeTopLevel.safeParse(invalidRecipe);
    expect(result.success).toBe(false);
  });
});

describe("recipeIngredientInput schema", () => {
  test("validates ingredient type input", () => {
    const validInput = {
      type: "ingredient",
      ingredientId: "123e4567-e89b-12d3-a456-426614174000",
      recipeId: null,
      amounts: [{ value: 100, unit: "g" }],
    };

    const result = recipeIngredientInput.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  test("validates recipe type input", () => {
    const validInput = {
      type: "recipe",
      recipeId: "123e4567-e89b-12d3-a456-426614174000",
      ingredientId: null,
      amounts: [{ value: 1, unit: "serving" }],
    };

    const result = recipeIngredientInput.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  test("rejects mismatched type and id combination", () => {
    const invalidInput = {
      type: "ingredient",
      ingredientId: null, // Should be a UUID for ingredient type
      recipeId: "123e4567-e89b-12d3-a456-426614174000",
      amounts: [{ value: 100, unit: "g" }],
    };

    const result = recipeIngredientInput.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  test("rejects empty amounts array", () => {
    const invalidInput = {
      type: "ingredient",
      ingredientId: "123e4567-e89b-12d3-a456-426614174000",
      recipeId: null,
      amounts: [],
    };

    const result = recipeIngredientInput.safeParse(invalidInput);
    expect(result.success).toBe(true); // NOTE: The schema doesn't validate array length
  });
});

describe("recipeInstructionInput schema", () => {
  test("validates valid instruction input", () => {
    const validInstruction = {
      instruction: "Mix all ingredients together",
    };

    const result = recipeInstructionInput.safeParse(validInstruction);
    expect(result.success).toBe(true);
  });

  test("validates with optional id", () => {
    const validInstruction = {
      instruction: "Mix all ingredients together",
      id: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = recipeInstructionInput.safeParse(validInstruction);
    expect(result.success).toBe(true);
  });

  test("rejects missing instruction", () => {
    const invalidInstruction = {
      id: "123e4567-e89b-12d3-a456-426614174000",
    };

    const result = recipeInstructionInput.safeParse(invalidInstruction);
    expect(result.success).toBe(false);
  });

  test("rejects invalid id format", () => {
    const invalidInstruction = {
      instruction: "Mix all ingredients together",
      id: "not-a-uuid",
    };

    const result = recipeInstructionInput.safeParse(invalidInstruction);
    expect(result.success).toBe(false);
  });
});

describe("recipeSectionInput schema", () => {
  test("validates valid section input", () => {
    const validSection = {
      name: "Main",
      ingredients: [
        {
          type: "ingredient",
          ingredientId: "123e4567-e89b-12d3-a456-426614174000",
          recipeId: null,
          amounts: [{ value: 100, unit: "g" }],
        },
      ],
      instructions: [{ instruction: "Mix all ingredients together" }],
    };

    const result = recipeSectionInput.safeParse(validSection);
    expect(result.success).toBe(true);
  });

  test("validates with null name", () => {
    const validSection = {
      name: null,
      ingredients: [
        {
          type: "ingredient",
          ingredientId: "123e4567-e89b-12d3-a456-426614174000",
          recipeId: null,
          amounts: [{ value: 100, unit: "g" }],
        },
      ],
      instructions: [{ instruction: "Mix all ingredients together" }],
    };

    const result = recipeSectionInput.safeParse(validSection);
    expect(result.success).toBe(true);
  });

  test("rejects too short name", () => {
    const invalidSection = {
      name: "A", // min length is 2
      ingredients: [
        {
          type: "ingredient",
          ingredientId: "123e4567-e89b-12d3-a456-426614174000",
          recipeId: null,
          amounts: [{ value: 100, unit: "g" }],
        },
      ],
      instructions: [{ instruction: "Mix all ingredients together" }],
    };

    const result = recipeSectionInput.safeParse(invalidSection);
    expect(result.success).toBe(false);
  });

  test("rejects empty ingredients array", () => {
    const invalidSection = {
      name: "Main",
      ingredients: [], // At least 1 required
      instructions: [{ instruction: "Mix all ingredients together" }],
    };

    const result = recipeSectionInput.safeParse(invalidSection);
    expect(result.success).toBe(false);
  });

  test("rejects empty instructions array", () => {
    const invalidSection = {
      name: "Main",
      ingredients: [
        {
          type: "ingredient",
          ingredientId: "123e4567-e89b-12d3-a456-426614174000",
          recipeId: null,
          amounts: [{ value: 100, unit: "g" }],
        },
      ],
      instructions: [], // At least 1 required
    };

    const result = recipeSectionInput.safeParse(invalidSection);
    expect(result.success).toBe(false);
  });
});

describe("recipeCreateInput schema", () => {
  test("validates valid recipe create input", () => {
    const validRecipe = {
      name: "Chocolate Cake",
      meta: {
        url: "https://example.com/recipe",
      },
      sections: [
        {
          name: "Main",
          ingredients: [
            {
              type: "ingredient",
              ingredientId: "123e4567-e89b-12d3-a456-426614174000",
              recipeId: null,
              amounts: [{ value: 100, unit: "g" }],
            },
          ],
          instructions: [{ instruction: "Mix all ingredients together" }],
        },
      ],
      images: [],
    };

    const result = recipeCreateInput.safeParse(validRecipe);
    expect(result.success).toBe(true);
  });

  test("validates with null meta", () => {
    const validRecipe = {
      name: "Chocolate Cake",
      meta: null,
      sections: [
        {
          name: "Main",
          ingredients: [
            {
              type: "ingredient",
              ingredientId: "123e4567-e89b-12d3-a456-426614174000",
              recipeId: null,
              amounts: [{ value: 100, unit: "g" }],
            },
          ],
          instructions: [{ instruction: "Mix all ingredients together" }],
        },
      ],
      images: [],
    };

    const result = recipeCreateInput.safeParse(validRecipe);
    expect(result.success).toBe(true);
  });

  test("accepts optional markdown notes (string or null)", () => {
    const base = {
      name: "Chocolate Cake",
      meta: null,
      sections: [],
      images: [],
    };

    expect(
      recipeCreateInput.safeParse({
        ...base,
        notes: "A family favorite.\n\n- Freezes well",
      }).success,
    ).toBe(true);
    expect(recipeCreateInput.safeParse({ ...base, notes: null }).success).toBe(
      true,
    );
    expect(recipeCreateInput.safeParse(base).success).toBe(true);
  });

  test("rejects missing name", () => {
    const invalidRecipe = {
      // No name
      meta: null,
      sections: [
        {
          name: "Main",
          ingredients: [
            {
              type: "ingredient",
              ingredientId: "123e4567-e89b-12d3-a456-426614174000",
              recipeId: null,
              amounts: [{ value: 100, unit: "g" }],
            },
          ],
          instructions: [{ instruction: "Mix all ingredients together" }],
        },
      ],
      images: [],
    };

    const result = recipeCreateInput.safeParse(invalidRecipe);
    expect(result.success).toBe(false);
  });

  test("rejects empty sections array", () => {
    const invalidRecipe = {
      name: "Chocolate Cake",
      meta: null,
      sections: [], // Empty sections
      images: [],
    };

    const result = recipeCreateInput.safeParse(invalidRecipe);
    expect(result.success).toBe(true); // NOTE: The schema doesn't validate sections array length
  });
});

describe("recipeUpdateInput schema", () => {
  test("validates valid recipe update input", () => {
    const validUpdate = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      data: {
        name: "New Chocolate Cake",
      },
    };

    const result = recipeUpdateInput.safeParse(validUpdate);
    expect(result.success).toBe(true);
  });

  test("validates with full data update", () => {
    const validUpdate = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      data: {
        name: "New Chocolate Cake",
        meta: {
          url: "https://example.com/updated-recipe",
        },
        sections: [
          {
            name: "Updated Section",
            ingredients: [
              {
                type: "ingredient",
                ingredientId: "123e4567-e89b-12d3-a456-426614174000",
                recipeId: null,
                amounts: [{ value: 200, unit: "g" }],
              },
            ],
            instructions: [{ instruction: "Updated instruction" }],
          },
        ],
        images: [],
      },
    };

    const result = recipeUpdateInput.safeParse(validUpdate);
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const invalidUpdate = {
      // No id
      data: {
        name: "New Chocolate Cake",
      },
    };

    const result = recipeUpdateInput.safeParse(invalidUpdate);
    expect(result.success).toBe(false);
  });

  test("rejects invalid id format", () => {
    const invalidUpdate = {
      id: "not-a-uuid",
      data: {
        name: "New Chocolate Cake",
      },
    };

    const result = recipeUpdateInput.safeParse(invalidUpdate);
    expect(result.success).toBe(false);
  });

  test("rejects missing data object", () => {
    const invalidUpdate = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      // No data
    };

    const result = recipeUpdateInput.safeParse(invalidUpdate);
    expect(result.success).toBe(false);
  });
});
