import { describe, expect, test } from "vitest";
import { configSchema, transformConfig } from "./config";

describe("configSchema with shorthand unit mappings", () => {
  test("parses config with shorthand unit mapping format", () => {
    const config = {
      locations: [],
      products: [
        {
          name: "White sugar",
          manufacturer: "C&H",
          ingredient: true,
          unit_mappings: ["4 lb = $5 @ whole foods", "1 cup = 120g"],
        },
      ],
    };

    const result = configSchema.parse(config);
    expect(result.products[0]!.name).toBe("White sugar");
    expect(result.products[0]!.unit_mappings?.[0]).toBe(
      "4 lb = $5 @ whole foods",
    );
    expect(result.products[0]!.unit_mappings?.[1]).toBe("1 cup = 120g");

    // Transform function converts to objects for backend
    const transformed = transformConfig(result);
    expect(transformed.products[0]!.unit_mappings?.[0]).toEqual({
      a: { value: 4, unit: "lb" },
      b: { value: 5, unit: "dollars" },
      source: "whole foods",
    });
    expect(transformed.products[0]!.unit_mappings?.[1]).toEqual({
      a: { value: 1, unit: "cup" },
      b: { value: 120, unit: "g" },
      source: null,
    });
  });

  test("parses multiple products with various unit mappings", () => {
    const config = {
      locations: [],
      products: [
        {
          name: "Butter",
          manufacturer: "generic",
          ingredient: true,
          unit_mappings: ["4 sticks = $8 @ whole foods", "1 stick = 113g"],
        },
        {
          name: "Eggs",
          manufacturer: "generic",
          ingredient: true,
          unit_mappings: ["12 eggs = $7 @ whole foods", "1 egg = 50g"],
        },
      ],
    };

    const result = configSchema.parse(config);
    expect(result.products).toHaveLength(2);

    // Check that strings are preserved
    expect(result.products[0]!.unit_mappings?.[0]).toBe(
      "4 sticks = $8 @ whole foods",
    );
    expect(result.products[1]!.unit_mappings?.[0]).toBe(
      "12 eggs = $7 @ whole foods",
    );

    // Transform and check objects
    const transformed = transformConfig(result);
    expect(transformed.products[0]!.unit_mappings?.[0]).toEqual({
      a: { value: 4, unit: "sticks" },
      b: { value: 8, unit: "dollars" },
      source: "whole foods",
    });
    expect(transformed.products[1]!.unit_mappings?.[0]).toEqual({
      a: { value: 12, unit: "eggs" },
      b: { value: 7, unit: "dollars" },
      source: "whole foods",
    });
  });

  test("handles products without unit mappings", () => {
    const config = {
      locations: [],
      products: [
        {
          name: "Tool",
          manufacturer: "Milwaukee",
          price_per: 99,
        },
      ],
    };

    const result = configSchema.parse(config);
    expect(result.products[0]!.name).toBe("Tool");
    expect(result.products[0]!.unit_mappings).toBeUndefined();
  });
});
