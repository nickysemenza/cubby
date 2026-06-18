import { describe, expect, it } from "vitest";
import { parseUsdaFoodRef } from "./parse-usda-food-ref";

describe("parseUsdaFoodRef", () => {
  it("parses a bare numeric id", () => {
    expect(parseUsdaFoodRef("384417")).toBe(384417);
    expect(parseUsdaFoodRef("  384417  ")).toBe(384417);
  });

  it("parses our worker URL", () => {
    expect(
      parseUsdaFoodRef("https://usda-api.nicky.workers.dev/api/foods/384417"),
    ).toBe(384417);
    expect(
      parseUsdaFoodRef(
        "https://usda-api.nicky.workers.dev/api/foods/384417?foo=bar",
      ),
    ).toBe(384417);
  });

  it("parses the FDC detail URL with trailing path", () => {
    expect(
      parseUsdaFoodRef(
        "https://fdc.nal.usda.gov/food-details/384417/nutrients",
      ),
    ).toBe(384417);
  });

  it("returns null for ordinary text searches", () => {
    expect(parseUsdaFoodRef("vanilla bean")).toBeNull();
    expect(parseUsdaFoodRef("")).toBeNull();
    expect(parseUsdaFoodRef("   ")).toBeNull();
    // Short numeric searches aren't hijacked as ids.
    expect(parseUsdaFoodRef("12")).toBeNull();
  });
});
