import { describe, expect, it } from "vitest";
import {
  recipeCreateInput,
  recipeIngredientInput,
  recipeInstructionInput,
  recipeSectionInput,
  recipeTopLevel,
  recipeUpdateInput,
} from "./recipe";

interface Case {
  name: string;
  input: unknown;
  valid: boolean;
}

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const now = new Date();
// Reusable valid building blocks the section/recipe cases compose from.
const ing = {
  type: "ingredient",
  ingredientId: UUID,
  recipeId: null,
  amounts: [{ value: 100, unit: "g" }],
};
const section = {
  name: "Main",
  ingredients: [ing],
  instructions: [{ instruction: "Mix all ingredients together" }],
};

describe("recipeTopLevel schema", () => {
  const CASES: Case[] = [
    {
      name: "valid top-level data",
      input: {
        id: UUID,
        name: "Chocolate Cake",
        meta: { url: "https://example.com/recipe" },
        createdAt: now,
        updatedAt: now,
      },
      valid: true,
    },
    {
      name: "null meta",
      input: {
        id: UUID,
        name: "Chocolate Cake",
        meta: null,
        createdAt: now,
        updatedAt: now,
      },
      valid: true,
    },
    {
      name: "invalid URL in meta",
      input: {
        id: UUID,
        name: "Chocolate Cake",
        meta: { url: "not-a-url" },
        createdAt: now,
        updatedAt: now,
      },
      valid: false,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(recipeTopLevel.safeParse(input).success).toBe(valid);
  });
});

describe("recipeIngredientInput schema", () => {
  const CASES: Case[] = [
    { name: "ingredient type", input: ing, valid: true },
    {
      name: "recipe type",
      input: {
        type: "recipe",
        recipeId: UUID,
        ingredientId: null,
        amounts: [{ value: 1, unit: "serving" }],
      },
      valid: true,
    },
    {
      name: "mismatched type and id",
      input: {
        type: "ingredient",
        ingredientId: null,
        recipeId: UUID,
        amounts: [{ value: 100, unit: "g" }],
      },
      valid: false,
    },
    // NOTE: the schema doesn't validate amounts array length.
    {
      name: "empty amounts array (allowed)",
      input: {
        type: "ingredient",
        ingredientId: UUID,
        recipeId: null,
        amounts: [],
      },
      valid: true,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(recipeIngredientInput.safeParse(input).success).toBe(valid);
  });
});

describe("recipeInstructionInput schema", () => {
  const CASES: Case[] = [
    {
      name: "valid instruction",
      input: { instruction: "Mix all ingredients together" },
      valid: true,
    },
    {
      name: "optional id",
      input: { instruction: "Mix all ingredients together", id: UUID },
      valid: true,
    },
    { name: "missing instruction", input: { id: UUID }, valid: false },
    {
      name: "invalid id format",
      input: { instruction: "Mix all ingredients together", id: "not-a-uuid" },
      valid: false,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(recipeInstructionInput.safeParse(input).success).toBe(valid);
  });
});

describe("recipeSectionInput schema", () => {
  const CASES: Case[] = [
    { name: "valid section", input: section, valid: true },
    { name: "null name", input: { ...section, name: null }, valid: true },
    {
      name: "too short name (min 2)",
      input: { ...section, name: "A" },
      valid: false,
    },
    {
      name: "empty ingredients array",
      input: { ...section, ingredients: [] },
      valid: false,
    },
    {
      name: "empty instructions array",
      input: { ...section, instructions: [] },
      valid: false,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(recipeSectionInput.safeParse(input).success).toBe(valid);
  });
});

describe("recipeCreateInput schema", () => {
  const base = { name: "Chocolate Cake", meta: null, sections: [], images: [] };
  const CASES: Case[] = [
    {
      name: "valid create input",
      input: {
        name: "Chocolate Cake",
        meta: { url: "https://example.com/recipe" },
        sections: [section],
        images: [],
      },
      valid: true,
    },
    {
      name: "null meta",
      input: {
        name: "Chocolate Cake",
        meta: null,
        sections: [section],
        images: [],
      },
      valid: true,
    },
    {
      name: "optional markdown notes (string)",
      input: { ...base, notes: "A family favorite.\n\n- Freezes well" },
      valid: true,
    },
    {
      name: "optional markdown notes (null)",
      input: { ...base, notes: null },
      valid: true,
    },
    { name: "notes omitted", input: base, valid: true },
    {
      name: "missing name",
      input: { meta: null, sections: [section], images: [] },
      valid: false,
    },
    // NOTE: the schema doesn't validate sections array length.
    {
      name: "empty sections array (allowed)",
      input: { name: "Chocolate Cake", meta: null, sections: [], images: [] },
      valid: true,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(recipeCreateInput.safeParse(input).success).toBe(valid);
  });
});

describe("recipeUpdateInput schema", () => {
  const CASES: Case[] = [
    {
      name: "valid update input",
      input: { id: UUID, data: { name: "New Chocolate Cake" } },
      valid: true,
    },
    {
      name: "full data update",
      input: {
        id: UUID,
        data: {
          name: "New Chocolate Cake",
          meta: { url: "https://example.com/updated-recipe" },
          sections: [
            {
              name: "Updated Section",
              ingredients: [{ ...ing, amounts: [{ value: 200, unit: "g" }] }],
              instructions: [{ instruction: "Updated instruction" }],
            },
          ],
          images: [],
        },
      },
      valid: true,
    },
    {
      name: "missing id",
      input: { data: { name: "New Chocolate Cake" } },
      valid: false,
    },
    {
      name: "invalid id format",
      input: { id: "not-a-uuid", data: { name: "New Chocolate Cake" } },
      valid: false,
    },
    { name: "missing data object", input: { id: UUID }, valid: false },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(recipeUpdateInput.safeParse(input).success).toBe(valid);
  });
});
