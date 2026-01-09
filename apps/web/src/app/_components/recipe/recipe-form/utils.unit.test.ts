import { describe, expect, it } from "vitest";
import type { IngItem } from "./types";
import { haveIngredientsChanged, haveInstructionsChanged } from "./utils";

describe("haveIngredientsChanged", () => {
  const baseIngredient: IngItem = {
    id: "ing-1",
    type: "ingredient",
    ingredient: { id: "i-1", name: "Flour" },
    recipe: null,
    amounts: [{ value: 1, unit: "cup" }],
  };

  const baseRecipeIngredient: IngItem = {
    id: "ing-2",
    type: "recipe",
    ingredient: null,
    recipe: { id: "r-1", name: "Pizza Dough" },
    amounts: [{ value: 2, unit: "batch" }],
  };

  it("returns false for identical ingredient arrays", () => {
    const original = [baseIngredient];
    const updated = [{ ...baseIngredient }];

    expect(haveIngredientsChanged(original, updated)).toBe(false);
  });

  it("returns false for empty arrays", () => {
    expect(haveIngredientsChanged([], [])).toBe(false);
  });

  it("returns true when ingredient is added", () => {
    const original: IngItem[] = [];
    const updated = [baseIngredient];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("returns true when ingredient is removed", () => {
    const original = [baseIngredient];
    const updated: IngItem[] = [];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("returns true when ingredient ID changes", () => {
    const original = [baseIngredient];
    const updated = [
      {
        ...baseIngredient,
        ingredient: { id: "i-2", name: "Sugar" },
      },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("returns true when amount value changes", () => {
    const original = [baseIngredient];
    const updated = [
      {
        ...baseIngredient,
        amounts: [{ value: 2, unit: "cup" }],
      },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("returns true when amount unit changes", () => {
    const original = [baseIngredient];
    const updated = [
      {
        ...baseIngredient,
        amounts: [{ value: 1, unit: "tbsp" }],
      },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("returns true when ingredient order changes", () => {
    const second: IngItem = {
      id: "ing-3",
      type: "ingredient",
      ingredient: { id: "i-2", name: "Sugar" },
      recipe: null,
      amounts: [{ value: 2, unit: "tbsp" }],
    };

    const original = [baseIngredient, second];
    const updated = [second, baseIngredient];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("returns true when type changes from ingredient to recipe", () => {
    const original = [baseIngredient];
    const updated = [baseRecipeIngredient];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("handles recipe type ingredients correctly", () => {
    const original = [baseRecipeIngredient];
    const updated = [{ ...baseRecipeIngredient }];

    expect(haveIngredientsChanged(original, updated)).toBe(false);
  });

  it("returns true when recipe ID changes", () => {
    const original = [baseRecipeIngredient];
    const updated = [
      {
        ...baseRecipeIngredient,
        recipe: { id: "r-2", name: "Pasta Dough" },
      },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("ignores ingredient name changes (only ID matters)", () => {
    const original = [baseIngredient];
    const updated = [
      {
        ...baseIngredient,
        ingredient: { id: "i-1", name: "All-Purpose Flour" },
      },
    ];

    // Name change doesn't matter, only ID
    expect(haveIngredientsChanged(original, updated)).toBe(false);
  });

  it("handles multiple amounts", () => {
    const withMultipleAmounts: IngItem = {
      ...baseIngredient,
      amounts: [
        { value: 1, unit: "cup" },
        { value: 8, unit: "oz" },
      ],
    };

    const original = [withMultipleAmounts];
    const updated = [{ ...withMultipleAmounts }];

    expect(haveIngredientsChanged(original, updated)).toBe(false);
  });

  it("returns true when one of multiple amounts changes", () => {
    const original: IngItem[] = [
      {
        ...baseIngredient,
        amounts: [
          { value: 1, unit: "cup" },
          { value: 8, unit: "oz" },
        ],
      },
    ];
    const updated: IngItem[] = [
      {
        ...baseIngredient,
        amounts: [
          { value: 1, unit: "cup" },
          { value: 16, unit: "oz" },
        ],
      },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });
});

describe("haveInstructionsChanged", () => {
  const baseInstruction = {
    id: "inst-1",
    instruction: "Preheat oven to 350°F",
  };

  it("returns false for identical instruction arrays", () => {
    const original = [baseInstruction];
    const updated = [{ ...baseInstruction }];

    expect(haveInstructionsChanged(original, updated)).toBe(false);
  });

  it("returns false for empty arrays", () => {
    expect(haveInstructionsChanged([], [])).toBe(false);
  });

  it("returns true when instruction is added", () => {
    const original: Array<{ id?: string; instruction: string }> = [];
    const updated = [baseInstruction];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });

  it("returns true when instruction is removed", () => {
    const original = [baseInstruction];
    const updated: Array<{ id?: string; instruction: string }> = [];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });

  it("returns true when instruction text changes", () => {
    const original = [baseInstruction];
    const updated = [
      { ...baseInstruction, instruction: "Preheat oven to 400°F" },
    ];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });

  it("returns true when instruction ID changes", () => {
    const original = [baseInstruction];
    const updated = [{ ...baseInstruction, id: "inst-2" }];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });

  it("returns true when instruction order changes", () => {
    const second = { id: "inst-2", instruction: "Mix ingredients" };
    const original = [baseInstruction, second];
    const updated = [second, baseInstruction];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });

  it("handles instructions without IDs", () => {
    const original = [{ instruction: "Step 1" }];
    const updated = [{ instruction: "Step 1" }];

    expect(haveInstructionsChanged(original, updated)).toBe(false);
  });

  it("returns true when ID is added to instruction", () => {
    const original = [{ instruction: "Step 1" }];
    const updated = [{ id: "new-id", instruction: "Step 1" }];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });

  it("handles multiple instructions", () => {
    const original = [
      { id: "1", instruction: "Step 1" },
      { id: "2", instruction: "Step 2" },
      { id: "3", instruction: "Step 3" },
    ];
    const updated = [
      { id: "1", instruction: "Step 1" },
      { id: "2", instruction: "Step 2" },
      { id: "3", instruction: "Step 3" },
    ];

    expect(haveInstructionsChanged(original, updated)).toBe(false);
  });

  it("returns true when middle instruction changes", () => {
    const original = [
      { id: "1", instruction: "Step 1" },
      { id: "2", instruction: "Step 2" },
      { id: "3", instruction: "Step 3" },
    ];
    const updated = [
      { id: "1", instruction: "Step 1" },
      { id: "2", instruction: "Step 2 modified" },
      { id: "3", instruction: "Step 3" },
    ];

    expect(haveInstructionsChanged(original, updated)).toBe(true);
  });
});
