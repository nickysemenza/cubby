import { describe, expect, test } from "vitest";
import {
  ingredientBase,
  ingredientOut,
  ingredientUpdateInput,
} from "./ingredient";

describe("ingredientBase schema", () => {
  test("validates valid ingredient data", () => {
    const validIngredient = {
      name: "Flour",
      aliases: ["All Purpose Flour", "Plain Flour"],
    };

    const result = ingredientBase.safeParse(validIngredient);
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const invalidIngredient = {
      aliases: ["All Purpose Flour", "Plain Flour"],
    };

    const result = ingredientBase.safeParse(invalidIngredient);
    expect(result.success).toBe(false);
  });

  test("rejects invalid aliases type", () => {
    const invalidIngredient = {
      name: "Flour",
      aliases: "All Purpose Flour", // Should be an array
    };

    const result = ingredientBase.safeParse(invalidIngredient);
    expect(result.success).toBe(false);
  });

  test("rejects non-string aliases", () => {
    const invalidIngredient = {
      name: "Flour",
      aliases: ["All Purpose Flour", 123], // Should be all strings
    };

    const result = ingredientBase.safeParse(invalidIngredient);
    expect(result.success).toBe(false);
  });
});

describe("ingredientOut schema", () => {
  test("validates valid ingredient output data", () => {
    const now = new Date();
    const validIngredientOut = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Flour",
      aliases: ["All Purpose Flour"],
      createdAt: now,
      updatedAt: now,
    };

    const result = ingredientOut.safeParse(validIngredientOut);
    expect(result.success).toBe(true);
  });

  test("rejects invalid UUID", () => {
    const now = new Date();
    const invalidIngredientOut = {
      id: "not-a-uuid",
      name: "Flour",
      aliases: ["All Purpose Flour"],
      createdAt: now,
      updatedAt: now,
    };

    const result = ingredientOut.safeParse(invalidIngredientOut);
    expect(result.success).toBe(false);
  });

  test("rejects missing timestamp fields", () => {
    const invalidIngredientOut = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Flour",
      aliases: ["All Purpose Flour"],
      // Missing createdAt and updatedAt
    };

    const result = ingredientOut.safeParse(invalidIngredientOut);
    expect(result.success).toBe(false);
  });
});

describe("ingredientUpdateInput schema", () => {
  test("validates valid update input with all fields", () => {
    const validUpdateInput = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      data: {
        name: "Flour",
        aliases: ["All Purpose Flour", "Plain Flour"],
      },
    };

    const result = ingredientUpdateInput.safeParse(validUpdateInput);
    expect(result.success).toBe(true);
  });

  test("validates valid update input with partial data", () => {
    const validUpdateInput = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      data: {
        name: "Flour",
        // No aliases
      },
    };

    const result = ingredientUpdateInput.safeParse(validUpdateInput);
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const invalidUpdateInput = {
      data: {
        name: "Flour",
        aliases: ["All Purpose Flour"],
      },
    };

    const result = ingredientUpdateInput.safeParse(invalidUpdateInput);
    expect(result.success).toBe(false);
  });

  test("rejects invalid id format", () => {
    const invalidUpdateInput = {
      id: "not-a-uuid",
      data: {
        name: "Flour",
        aliases: ["All Purpose Flour"],
      },
    };

    const result = ingredientUpdateInput.safeParse(invalidUpdateInput);
    expect(result.success).toBe(false);
  });

  test("rejects missing data object", () => {
    const invalidUpdateInput = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      // No data property
    };

    const result = ingredientUpdateInput.safeParse(invalidUpdateInput);
    expect(result.success).toBe(false);
  });
});
