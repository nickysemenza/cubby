import { describe, expect, it } from "vitest";
import { mcpUnitMappingInput, unitMappingInput } from "./unitmapping";

describe.each([unitMappingInput, mcpUnitMappingInput])(
  "mapping ingestion",
  (schema) => {
    const edge = {
      a: { value: 100, unit: "g" },
      b: { value: 0, unit: "mg sodium" },
      source: "Nutrition label",
    };

    it("preserves an explicit zero nutrient target", () => {
      expect(schema.parse(edge).b.value).toBe(0);
    });

    it("requires a positive source and a nonnegative target", () => {
      expect(
        schema.safeParse({ ...edge, a: { ...edge.a, value: 0 } }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...edge, b: { ...edge.b, value: -1 } }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...edge, b: { unit: "mg sodium" } }).success,
      ).toBe(false);
    });
  },
);
