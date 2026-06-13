import { describe, expect, it } from "vitest";
import {
  ingredientBase,
  ingredientOut,
  ingredientUpdateInput,
} from "./ingredient";

interface Case {
  name: string;
  input: unknown;
  valid: boolean;
}

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("ingredientBase schema", () => {
  const CASES: Case[] = [
    {
      name: "valid ingredient data",
      input: { name: "Flour", aliases: ["All Purpose Flour", "Plain Flour"] },
      valid: true,
    },
    {
      name: "missing name",
      input: { aliases: ["All Purpose Flour", "Plain Flour"] },
      valid: false,
    },
    {
      name: "aliases not an array",
      input: { name: "Flour", aliases: "All Purpose Flour" },
      valid: false,
    },
    {
      name: "non-string alias",
      input: { name: "Flour", aliases: ["All Purpose Flour", 123] },
      valid: false,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(ingredientBase.safeParse(input).success).toBe(valid);
  });
});

describe("ingredientOut schema", () => {
  const now = new Date();
  const CASES: Case[] = [
    {
      name: "valid output data",
      input: {
        id: UUID,
        name: "Flour",
        aliases: ["All Purpose Flour"],
        createdAt: now,
        updatedAt: now,
      },
      valid: true,
    },
    {
      name: "invalid UUID",
      input: {
        id: "not-a-uuid",
        name: "Flour",
        aliases: ["All Purpose Flour"],
        createdAt: now,
        updatedAt: now,
      },
      valid: false,
    },
    {
      name: "missing timestamp fields",
      input: { id: UUID, name: "Flour", aliases: ["All Purpose Flour"] },
      valid: false,
    },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(ingredientOut.safeParse(input).success).toBe(valid);
  });
});

describe("ingredientUpdateInput schema", () => {
  const CASES: Case[] = [
    {
      name: "all fields",
      input: {
        id: UUID,
        data: { name: "Flour", aliases: ["All Purpose Flour", "Plain Flour"] },
      },
      valid: true,
    },
    {
      name: "partial data (no aliases)",
      input: { id: UUID, data: { name: "Flour" } },
      valid: true,
    },
    {
      name: "missing id",
      input: { data: { name: "Flour", aliases: ["All Purpose Flour"] } },
      valid: false,
    },
    {
      name: "invalid id format",
      input: {
        id: "not-a-uuid",
        data: { name: "Flour", aliases: ["All Purpose Flour"] },
      },
      valid: false,
    },
    { name: "missing data object", input: { id: UUID }, valid: false },
  ];

  it.each(CASES)("$name → $valid", ({ input, valid }) => {
    expect(ingredientUpdateInput.safeParse(input).success).toBe(valid);
  });
});
