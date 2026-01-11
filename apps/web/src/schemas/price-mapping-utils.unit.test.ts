import { beforeAll, describe, expect, it } from "vitest";
import { ensureWasm } from "~/lib/wasm";
import {
  computeInventoryValuation,
  computeProductPrice,
  extractPriceFromMappings,
  findPriceMapping,
  isMoneyUnit,
  serializeUnitMappings,
  syncPriceToMappings,
} from "./price-mapping-utils";

// Initialize WASM before tests run
beforeAll(async () => {
  await ensureWasm();
});

describe("isMoneyUnit", () => {
  it("returns true for dollar", () => {
    expect(isMoneyUnit("dollar")).toBe(true);
  });

  it("returns true for Dollar (case insensitive)", () => {
    expect(isMoneyUnit("Dollar")).toBe(true);
  });

  it("returns false for weight units", () => {
    expect(isMoneyUnit("gram")).toBe(false);
    expect(isMoneyUnit("kg")).toBe(false);
    expect(isMoneyUnit("lb")).toBe(false);
  });

  it("returns false for count units", () => {
    expect(isMoneyUnit("each")).toBe(false);
  });

  it("returns false for volume units", () => {
    expect(isMoneyUnit("ml")).toBe(false);
    expect(isMoneyUnit("cup")).toBe(false);
  });
});

describe("findPriceMapping", () => {
  it("finds price in b position (1 each -> $X)", () => {
    const mappings = [
      { a: { value: 1, unit: "each" }, b: { value: 5.99, unit: "dollar" } },
    ];
    const result = findPriceMapping(mappings);
    expect(result).not.toBeNull();
    expect(result?.index).toBe(0);
    expect(result?.price).toEqual({ value: 5.99, unit: "dollar" });
  });

  it("finds price in a position ($X -> 1 each)", () => {
    const mappings = [
      { a: { value: 5.99, unit: "dollar" }, b: { value: 1, unit: "each" } },
    ];
    const result = findPriceMapping(mappings);
    expect(result).not.toBeNull();
    expect(result?.index).toBe(0);
    expect(result?.price).toEqual({ value: 5.99, unit: "dollar" });
  });

  it("returns null when no price mapping exists", () => {
    const mappings = [
      { a: { value: 1, unit: "lb" }, b: { value: 454, unit: "gram" } },
    ];
    const result = findPriceMapping(mappings);
    expect(result).toBeNull();
  });

  it("finds price mapping among multiple mappings", () => {
    const mappings = [
      { a: { value: 1, unit: "lb" }, b: { value: 454, unit: "gram" } },
      { a: { value: 1, unit: "each" }, b: { value: 12.99, unit: "dollar" } },
      { a: { value: 1, unit: "cup" }, b: { value: 240, unit: "ml" } },
    ];
    const result = findPriceMapping(mappings);
    expect(result).not.toBeNull();
    expect(result?.index).toBe(1);
    expect(result?.price).toEqual({ value: 12.99, unit: "dollar" });
  });

  it("returns null for empty mappings", () => {
    const result = findPriceMapping([]);
    expect(result).toBeNull();
  });
});

describe("extractPriceFromMappings", () => {
  it("extracts price amount from mappings", () => {
    const mappings = [
      { a: { value: 1, unit: "each" }, b: { value: 9.99, unit: "dollar" } },
    ];
    const result = extractPriceFromMappings(mappings);
    expect(result).toEqual({ value: 9.99, unit: "dollar" });
  });

  it("returns null when no price mapping exists", () => {
    const mappings = [
      { a: { value: 1, unit: "lb" }, b: { value: 454, unit: "gram" } },
    ];
    const result = extractPriceFromMappings(mappings);
    expect(result).toBeNull();
  });
});

describe("computeProductPrice", () => {
  it("computes price value from unit mappings", () => {
    const mappings = [
      { a: { value: 1, unit: "each" }, b: { value: 25.5, unit: "dollar" } },
    ];
    const price = computeProductPrice(mappings);
    expect(price).toBe(25.5);
  });

  it("returns null when no price mapping exists", () => {
    const mappings = [
      { a: { value: 1, unit: "lb" }, b: { value: 454, unit: "gram" } },
    ];
    const price = computeProductPrice(mappings);
    expect(price).toBeNull();
  });

  it("returns null for empty mappings", () => {
    const price = computeProductPrice([]);
    expect(price).toBeNull();
  });
});

describe("computeInventoryValuation", () => {
  it("computes valuation as amount * price", () => {
    const valuation = computeInventoryValuation(5, 10.0);
    expect(valuation).toBe(50.0);
  });

  it("handles decimal values correctly", () => {
    const valuation = computeInventoryValuation(2.5, 4.99);
    expect(valuation).toBeCloseTo(12.475);
  });

  it("returns null when product price is null", () => {
    const valuation = computeInventoryValuation(5, null);
    expect(valuation).toBeNull();
  });

  it("returns 0 when amount is 0", () => {
    const valuation = computeInventoryValuation(0, 10.0);
    expect(valuation).toBe(0);
  });
});

describe("syncPriceToMappings", () => {
  it("adds price mapping when none exists", () => {
    const mappings: Array<{
      a: { value: number; unit: string };
      b: { value: number; unit: string };
      source?: string | null;
    }> = [];
    const result = syncPriceToMappings(mappings, {
      value: 9.99,
      unit: "dollar",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      a: { value: 1, unit: "each" },
      b: { value: 9.99, unit: "dollar" },
      source: "manual",
    });
  });

  it("updates existing price mapping", () => {
    const mappings = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 5.99, unit: "dollar" },
        source: "csv",
      },
    ];
    const result = syncPriceToMappings(mappings, {
      value: 7.99,
      unit: "dollar",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.b.value).toBe(7.99);
    expect(result[0]?.source).toBe("csv"); // Preserves existing source
  });

  it("removes price mapping when price is null", () => {
    const mappings = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 5.99, unit: "dollar" },
        source: "manual",
      },
      {
        a: { value: 1, unit: "lb" },
        b: { value: 454, unit: "gram" },
        source: "usda",
      },
    ];
    const result = syncPriceToMappings(mappings, null);
    expect(result).toHaveLength(1);
    expect(result[0]?.a.unit).toBe("lb");
  });

  it("preserves non-price mappings when adding price", () => {
    const mappings = [
      {
        a: { value: 1, unit: "lb" },
        b: { value: 454, unit: "gram" },
        source: "usda",
      },
    ];
    const result = syncPriceToMappings(mappings, {
      value: 12.99,
      unit: "dollar",
    });
    expect(result).toHaveLength(2);
    expect(result.find((m) => m.a.unit === "lb")).toBeTruthy();
    expect(result.find((m) => m.b.unit === "dollar")).toBeTruthy();
  });

  it("uses default currency when not specified", () => {
    const mappings: Array<{
      a: { value: number; unit: string };
      b: { value: number; unit: string };
      source?: string | null;
    }> = [];
    const result = syncPriceToMappings(mappings, { value: 9.99, unit: "" });
    expect(result[0]?.b.unit).toBe("dollar");
  });
});

describe("serializeUnitMappings", () => {
  it("serializes non-price mappings to string", () => {
    const mappings = [
      {
        a: { value: 1, unit: "lb" },
        b: { value: 454, unit: "gram" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("1 lb = 454 gram");
  });

  it("includes source annotation when present", () => {
    const mappings = [
      {
        a: { value: 1, unit: "lb" },
        b: { value: 454, unit: "gram" },
        source: "usda",
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("1 lb = 454 gram @ usda");
  });

  it("excludes price mappings", () => {
    const mappings = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 9.99, unit: "dollar" },
        source: null,
      },
      {
        a: { value: 1, unit: "lb" },
        b: { value: 454, unit: "gram" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("1 lb = 454 gram");
  });

  it("joins multiple mappings with semicolon", () => {
    const mappings = [
      {
        a: { value: 1, unit: "lb" },
        b: { value: 454, unit: "gram" },
        source: null,
      },
      {
        a: { value: 1, unit: "cup" },
        b: { value: 240, unit: "ml" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("1 lb = 454 gram; 1 cup = 240 ml");
  });

  it("returns null for empty mappings", () => {
    const result = serializeUnitMappings([]);
    expect(result).toBeNull();
  });

  it("returns null when only canonical price mappings exist", () => {
    const mappings = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 9.99, unit: "dollar" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBeNull();
  });

  it("includes non-canonical price mappings in serialization", () => {
    const mappings = [
      {
        a: { value: 2, unit: "oz" },
        b: { value: 8, unit: "dollar" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("2 oz = 8 dollar");
  });

  it("excludes canonical price but includes other mappings", () => {
    const mappings = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 5, unit: "dollar" },
        source: null,
      },
      {
        a: { value: 1, unit: "cup" },
        b: { value: 120, unit: "g" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("1 cup = 120 g");
  });

  it("includes all non-canonical mappings including non-canonical prices", () => {
    const mappings = [
      {
        a: { value: 1, unit: "each" },
        b: { value: 5, unit: "dollar" },
        source: null,
      },
      {
        a: { value: 1, unit: "cup" },
        b: { value: 120, unit: "g" },
        source: null,
      },
      {
        a: { value: 4, unit: "lb" },
        b: { value: 20, unit: "dollar" },
        source: null,
      },
    ];
    const result = serializeUnitMappings(mappings);
    expect(result).toBe("1 cup = 120 g; 4 lb = 20 dollar");
  });
});
