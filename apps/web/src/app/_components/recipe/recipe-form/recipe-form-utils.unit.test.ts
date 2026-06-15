import { describe, expect, it } from "vitest";
import {
  haveIngredientsChanged,
  haveInstructionsChanged,
  normalizeAmounts,
} from "./recipe-form-utils";
import type { IngItem } from "./types";

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

  const second: IngItem = {
    id: "ing-3",
    type: "ingredient",
    ingredient: { id: "i-2", name: "Sugar" },
    recipe: null,
    amounts: [{ value: 2, unit: "tbsp" }],
  };

  const withMultipleAmounts: IngItem = {
    ...baseIngredient,
    amounts: [
      { value: 1, unit: "cup" },
      { value: 8, unit: "oz" },
    ],
  };

  it.each<[string, IngItem[], IngItem[], boolean]>([
    [
      "identical ingredient arrays",
      [baseIngredient],
      [{ ...baseIngredient }],
      false,
    ],
    ["empty arrays", [], [], false],
    ["ingredient is added", [], [baseIngredient], true],
    ["ingredient is removed", [baseIngredient], [], true],
    [
      "ingredient ID changes",
      [baseIngredient],
      [{ ...baseIngredient, ingredient: { id: "i-2", name: "Sugar" } }],
      true,
    ],
    [
      "amount value changes",
      [baseIngredient],
      [{ ...baseIngredient, amounts: [{ value: 2, unit: "cup" }] }],
      true,
    ],
    [
      "amount unit changes",
      [baseIngredient],
      [{ ...baseIngredient, amounts: [{ value: 1, unit: "tbsp" }] }],
      true,
    ],
    [
      "ingredient order changes",
      [baseIngredient, second],
      [second, baseIngredient],
      true,
    ],
    [
      "type changes from ingredient to recipe",
      [baseIngredient],
      [baseRecipeIngredient],
      true,
    ],
    [
      "recipe type ingredients are unchanged",
      [baseRecipeIngredient],
      [{ ...baseRecipeIngredient }],
      false,
    ],
    [
      "recipe ID changes",
      [baseRecipeIngredient],
      [{ ...baseRecipeIngredient, recipe: { id: "r-2", name: "Pasta Dough" } }],
      true,
    ],
    // Name change doesn't matter, only ID
    [
      "ingredient name changes (only ID matters)",
      [baseIngredient],
      [
        {
          ...baseIngredient,
          ingredient: { id: "i-1", name: "All-Purpose Flour" },
        },
      ],
      false,
    ],
    [
      "multiple amounts are unchanged",
      [withMultipleAmounts],
      [{ ...withMultipleAmounts }],
      false,
    ],
    [
      "one of multiple amounts changes",
      [withMultipleAmounts],
      [
        {
          ...baseIngredient,
          amounts: [
            { value: 1, unit: "cup" },
            { value: 16, unit: "oz" },
          ],
        },
      ],
      true,
    ],
  ])("%s -> %s", (_name, original, updated, expected) => {
    expect(haveIngredientsChanged(original, updated)).toBe(expected);
  });

  // An amount-less ingredient (e.g. oil for frying) loads from the DB as `[]` but
  // is seeded with a blank form slot. The two must compare equal so editing an
  // untouched recipe doesn't fire a spurious update.
  it("treats a blank-slot amount as equal to no amounts", () => {
    const original: IngItem[] = [{ ...baseIngredient, amounts: [] }];
    const updated: IngItem[] = [
      { ...baseIngredient, amounts: [{ value: null, unit: "" }] },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(false);
  });

  // The modifier is user-editable and drives the absorbed-oil estimate, so a
  // modifier-only edit must register as a change (else it's silently dropped).
  it("returns true when only the modifier changes", () => {
    const original: IngItem[] = [
      { ...baseIngredient, amounts: [], modifier: null },
    ];
    const updated: IngItem[] = [
      { ...baseIngredient, amounts: [], modifier: "for frying" },
    ];

    expect(haveIngredientsChanged(original, updated)).toBe(true);
  });

  it("ignores blank-vs-null modifier differences", () => {
    const original: IngItem[] = [
      { ...baseIngredient, modifier: null as string | null },
    ];
    const updated: IngItem[] = [{ ...baseIngredient, modifier: "  " }];

    expect(haveIngredientsChanged(original, updated)).toBe(false);
  });
});

describe("normalizeAmounts", () => {
  it.each<
    [
      string,
      Array<{ value: number | null; unit: string }>,
      Array<{ value: number | null; unit: string }>,
    ]
  >([
    ["drops a fully-blank amount", [{ value: null, unit: "" }], []],
    [
      "drops a blank amount with whitespace-only unit",
      [{ value: null, unit: "  " }],
      [],
    ],
    [
      "keeps a complete amount",
      [{ value: 250, unit: "g" }],
      [{ value: 250, unit: "g" }],
    ],
    [
      "keeps complete amounts and drops blank ones",
      [
        { value: 1, unit: "cup" },
        { value: null, unit: "" },
      ],
      [{ value: 1, unit: "cup" }],
    ],
  ])("%s", (_name, input, expected) => {
    expect(normalizeAmounts(input)).toEqual(expected);
  });
});

describe("haveInstructionsChanged", () => {
  const baseInstruction = {
    id: "inst-1",
    instruction: "Preheat oven to 350°F",
  };

  const threeSteps = [
    { id: "1", instruction: "Step 1" },
    { id: "2", instruction: "Step 2" },
    { id: "3", instruction: "Step 3" },
  ];

  type Instruction = { id?: string; instruction: string };

  it.each<[string, Instruction[], Instruction[], boolean]>([
    [
      "identical instruction arrays",
      [baseInstruction],
      [{ ...baseInstruction }],
      false,
    ],
    ["empty arrays", [], [], false],
    ["instruction is added", [], [baseInstruction], true],
    ["instruction is removed", [baseInstruction], [], true],
    [
      "instruction text changes",
      [baseInstruction],
      [{ ...baseInstruction, instruction: "Preheat oven to 400°F" }],
      true,
    ],
    [
      "instruction ID changes",
      [baseInstruction],
      [{ ...baseInstruction, id: "inst-2" }],
      true,
    ],
    [
      "instruction order changes",
      [baseInstruction, { id: "inst-2", instruction: "Mix ingredients" }],
      [{ id: "inst-2", instruction: "Mix ingredients" }, baseInstruction],
      true,
    ],
    [
      "instructions without IDs",
      [{ instruction: "Step 1" }],
      [{ instruction: "Step 1" }],
      false,
    ],
    [
      "ID is added to instruction",
      [{ instruction: "Step 1" }],
      [{ id: "new-id", instruction: "Step 1" }],
      true,
    ],
    [
      "multiple unchanged instructions",
      threeSteps,
      threeSteps.map((s) => ({ ...s })),
      false,
    ],
    [
      "middle instruction changes",
      threeSteps,
      [
        { id: "1", instruction: "Step 1" },
        { id: "2", instruction: "Step 2 modified" },
        { id: "3", instruction: "Step 3" },
      ],
      true,
    ],
  ])("%s -> %s", (_name, original, updated, expected) => {
    expect(haveInstructionsChanged(original, updated)).toBe(expected);
  });
});
