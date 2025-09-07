import { describe, expect, test } from "vitest";
import { parseConversionString, parseProductShorthand } from "./config-parsers";

describe("parseConversionString", () => {
  test("parses basic conversion", () => {
    const result = parseConversionString("4 lb = $5");
    expect(result).toEqual({
      from: { value: 4, unit: "lb" },
      to: { value: 5, unit: "dollars" },
      source: undefined,
    });
  });

  test("parses conversion with source", () => {
    const result = parseConversionString("4 lb = $5 @ whole foods");
    expect(result).toEqual({
      from: { value: 4, unit: "lb" },
      to: { value: 5, unit: "dollars" },
      source: "whole foods",
    });
  });

  test("parses weight conversion", () => {
    const result = parseConversionString("1 cup = 120g");
    expect(result).toEqual({
      from: { value: 1, unit: "cup" },
      to: { value: 120, unit: "g" },
      source: undefined,
    });
  });

  test("handles decimal values", () => {
    const result = parseConversionString("2.5 cups = $3.50");
    expect(result).toEqual({
      from: { value: 2.5, unit: "cups" },
      to: { value: 3.5, unit: "dollars" },
      source: undefined,
    });
  });

  test("throws error for invalid format", () => {
    expect(() => parseConversionString("invalid")).toThrow(
      "Invalid conversion format",
    );
    expect(() => parseConversionString("4 lb")).toThrow(
      "Invalid conversion format",
    );
    expect(() => parseConversionString("= $5")).toThrow(
      "Invalid conversion format",
    );
  });
});

describe("parseProductShorthand", () => {
  test("parses basic product shorthand", () => {
    const result = parseProductShorthand("White sugar: $5/4lb");
    expect(result).toEqual({
      name: "White sugar",
      conversions: ["4 lb = $5"],
    });
  });

  test("parses product shorthand with source", () => {
    const result = parseProductShorthand("White sugar: $5/4lb @ whole foods");
    expect(result).toEqual({
      name: "White sugar",
      conversions: ["4 lb = $5 @ whole foods"],
    });
  });

  test("handles complex unit names", () => {
    const result = parseProductShorthand("Butter: $8/4sticks @ store");
    expect(result).toEqual({
      name: "Butter",
      conversions: ["4 sticks = $8 @ store"],
    });
  });

  test("throws error for invalid format", () => {
    expect(() => parseProductShorthand("No colon here")).toThrow(
      "Invalid product shorthand",
    );
    expect(() => parseProductShorthand("Product: invalid")).toThrow(
      "Invalid price shorthand",
    );
  });
});
