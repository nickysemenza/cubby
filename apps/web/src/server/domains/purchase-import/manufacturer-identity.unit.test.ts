import { describe, expect, it } from "vitest";

import {
  MODEL_STYLE_MATCH_REASON,
  manufacturerPartRequests,
  modelStyleTokens,
  sharesModelWithinManufacturer,
} from "./manufacturer-identity";

const tee = { manufacturer: "ForgeWear", model: "TEE-100" };

describe("sharesModelWithinManufacturer", () => {
  it("matches a model token in the title when the manufacturer is also named", () => {
    expect(
      sharesModelWithinManufacturer("ForgeWear Crew Tee TEE-100 Black M", tee),
    ).toBe(true);
  });

  it("ignores punctuation and case differences in the model", () => {
    expect(
      sharesModelWithinManufacturer("forgewear crew tee tee100 black", tee),
    ).toBe(true);
  });

  it("requires the same manufacturer: a coincidental model elsewhere does not corroborate", () => {
    expect(
      sharesModelWithinManufacturer("AnvilCo Work Shirt TEE-100", tee),
    ).toBe(false);
  });

  it("does not match a different model of the same manufacturer", () => {
    expect(
      sharesModelWithinManufacturer("ForgeWear Crew Tee TEE-200", tee),
    ).toBe(false);
  });

  it("never matches a blank, short, or digit-free model", () => {
    for (const model of [null, "", "  ", "T1", "Crew"]) {
      expect(
        sharesModelWithinManufacturer("ForgeWear Crew T1 Tee", {
          manufacturer: "ForgeWear",
          model,
        }),
      ).toBe(false);
    }
  });

  it("does not match when the product has no manufacturer", () => {
    expect(
      sharesModelWithinManufacturer("Crew Tee TEE-100", {
        manufacturer: "",
        model: "TEE-100",
      }),
    ).toBe(false);
  });
});

describe("modelStyleTokens", () => {
  it("keeps only alphanumeric tokens with a digit", () => {
    expect(modelStyleTokens("ForgeWear Crew Tee TEE-100 Black 2-pack")).toEqual(
      ["TEE-100", "2-pack"],
    );
  });
});

describe("manufacturerPartRequests", () => {
  it("guesses manufacturer sources from leading title words for the line SKU", () => {
    expect(
      manufacturerPartRequests({
        title: "ForgeWear Apparel Crew Tee",
        sku: "TEE-100-BLK-M",
      }).map(({ source }) => source),
    ).toEqual(["forgewear", "forgewear-apparel", "forgewear-apparel-crew"]);
  });

  it("requests the manufacturer_part kind with the SKU as the value", () => {
    expect(
      manufacturerPartRequests({
        title: "ForgeWear Tee",
        sku: "TEE-100-BLK-M",
      })[0],
    ).toEqual({
      source: "forgewear",
      kind: "manufacturer_part",
      externalId: "TEE-100-BLK-M",
    });
  });

  it("requests nothing without a SKU", () => {
    expect(manufacturerPartRequests({ title: "ForgeWear Tee" })).toEqual([]);
  });

  it("states the confirm-size-and-color reason", () => {
    expect(MODEL_STYLE_MATCH_REASON).toContain("confirm size and color");
  });
});
