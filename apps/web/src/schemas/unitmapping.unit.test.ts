import { describe, expect, test } from "vitest";
import { unitMappingFlexible, transformUnitMapping } from "./unitmapping";

describe("unitMappingFlexible", () => {
  test("validates shorthand format with source", () => {
    const shorthand = "4 lb = $5 @ whole foods";
    const result = unitMappingFlexible.parse(shorthand);

    // Schema now just validates and returns the string
    expect(result).toBe(shorthand);

    // Transform function converts to object
    const transformed = transformUnitMapping(shorthand);
    expect(transformed).toEqual({
      a: { value: 4, unit: "lb" },
      b: { value: 5, unit: "dollars" },
      source: "whole foods",
    });
  });

  test("validates shorthand format without source", () => {
    const shorthand = "1 cup = 120g";
    const result = unitMappingFlexible.parse(shorthand);

    expect(result).toBe(shorthand);

    const transformed = transformUnitMapping(shorthand);
    expect(transformed).toEqual({
      a: { value: 1, unit: "cup" },
      b: { value: 120, unit: "g" },
      source: null,
    });
  });

  test("validates and transforms decimal values", () => {
    const shorthand = "2.5 cups = $3.50";
    const result = unitMappingFlexible.parse(shorthand);

    expect(result).toBe(shorthand);

    const transformed = transformUnitMapping(shorthand);
    expect(transformed).toEqual({
      a: { value: 2.5, unit: "cups" },
      b: { value: 3.5, unit: "dollars" },
      source: null,
    });
  });

  test("validates and transforms various unit formats", () => {
    const examples = [
      {
        input: "1 stick = 113g",
        expected: {
          a: { value: 1, unit: "stick" },
          b: { value: 113, unit: "g" },
          source: null,
        },
      },
      {
        input: "12 eggs = $7 @ store",
        expected: {
          a: { value: 12, unit: "eggs" },
          b: { value: 7, unit: "dollars" },
          source: "store",
        },
      },
      {
        input: "2 lbs = $6",
        expected: {
          a: { value: 2, unit: "lbs" },
          b: { value: 6, unit: "dollars" },
          source: null,
        },
      },
    ];

    examples.forEach(({ input, expected }) => {
      const result = unitMappingFlexible.parse(input);
      expect(result).toBe(input); // Validation just returns the string

      const transformed = transformUnitMapping(input);
      expect(transformed).toEqual(expected);
    });
  });
});
