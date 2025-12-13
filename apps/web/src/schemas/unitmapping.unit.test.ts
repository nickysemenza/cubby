import { beforeAll, describe, expect, test } from "vitest";
import {
  unitMappingFlexible,
  transformUnitMapping,
  parseUnitMappingString,
  isValidUnitMappingString,
} from "./unitmapping";
import { ensureWasm } from "~/lib/wasm";

// Initialize WASM before all tests
beforeAll(async () => {
  await ensureWasm();
});

describe("parseUnitMappingString", () => {
  test("parses conversion format with source", async () => {
    const result = await parseUnitMappingString("4 lb = $5 @ whole foods");
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.b.unit).toBe("$"); // Canonical form
    expect(result.source).toBe("whole foods");
  });

  test("parses conversion format without source", async () => {
    const result = await parseUnitMappingString("1 cup = 120g");
    expect(result.a.value).toBe(1);
    expect(result.a.unit).toBe("cup");
    expect(result.b.value).toBe(120);
    expect(result.b.unit).toBe("g");
    expect(result.source).toBeNull();
  });

  test("parses price-per format", async () => {
    const result = await parseUnitMappingString("$5/4lb");
    // Note: normalized order - amount first, then price
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.b.unit).toBe("$");
  });

  test("parses price-per format with source", async () => {
    const result = await parseUnitMappingString("$5/4lb @ costco");
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.source).toBe("costco");
  });

  test("parses decimal values", async () => {
    const result = await parseUnitMappingString("2.5 cups = $3.50");
    expect(result.a.value).toBe(2.5);
    expect(result.a.unit).toBe("cup"); // Singularized
    expect(result.b.value).toBe(3.5);
    expect(result.b.unit).toBe("$");
  });

  test("parses various unit formats", async () => {
    const examples = [
      {
        input: "1 stick = 113g",
        expected: { a: { value: 1, unit: "stick" }, b: { value: 113, unit: "g" } },
      },
      {
        input: "12 eggs = $7 @ store",
        expected: { a: { value: 12, unit: "egg" }, b: { value: 7, unit: "$" }, source: "store" },
      },
      {
        input: "2 lbs = $6",
        expected: { a: { value: 2, unit: "lb" }, b: { value: 6, unit: "$" } },
      },
    ];

    for (const { input, expected } of examples) {
      const result = await parseUnitMappingString(input);
      expect(result.a.value).toBe(expected.a.value);
      expect(result.a.unit).toBe(expected.a.unit);
      expect(result.b.value).toBe(expected.b.value);
      expect(result.b.unit).toBe(expected.b.unit);
      if (expected.source) {
        expect(result.source).toBe(expected.source);
      }
    }
  });

  test("throws on invalid input", async () => {
    await expect(parseUnitMappingString("invalid")).rejects.toThrow();
    await expect(parseUnitMappingString("4 lb")).rejects.toThrow();
    await expect(parseUnitMappingString("")).rejects.toThrow();
  });
});

describe("isValidUnitMappingString", () => {
  test("returns true for valid inputs", async () => {
    expect(await isValidUnitMappingString("4 lb = $5")).toBe(true);
    expect(await isValidUnitMappingString("$5/4lb")).toBe(true);
    expect(await isValidUnitMappingString("1 cup = 120g @ store")).toBe(true);
  });

  test("returns false for invalid inputs", async () => {
    expect(await isValidUnitMappingString("invalid")).toBe(false);
    expect(await isValidUnitMappingString("4 lb")).toBe(false);
    expect(await isValidUnitMappingString("")).toBe(false);
  });
});

describe("unitMappingFlexible", () => {
  test("validates non-empty string", () => {
    expect(unitMappingFlexible.parse("4 lb = $5")).toBe("4 lb = $5");
    expect(unitMappingFlexible.parse("$5/4lb")).toBe("$5/4lb");
    expect(() => unitMappingFlexible.parse("")).toThrow();
  });
});

describe("transformUnitMapping", () => {
  test("transforms conversion format", async () => {
    const result = await transformUnitMapping("4 lb = $5 @ store");
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.b.unit).toBe("$");
    expect(result.source).toBe("store");
  });

  test("transforms price-per format", async () => {
    const result = await transformUnitMapping("$5/4lb");
    expect(result.a.value).toBe(4);
    expect(result.a.unit).toBe("lb");
    expect(result.b.value).toBe(5);
    expect(result.b.unit).toBe("$");
    expect(result.source).toBeNull();
  });
});
