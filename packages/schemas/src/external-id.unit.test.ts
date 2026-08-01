import { describe, expect, it } from "vitest";
import {
  canonicalExternalIdUrl,
  externalIdInputs,
  externalIdSource,
  storedExternalIdUrl,
} from "./external-id";

describe("external identifiers", () => {
  it("normalizes canonical source slugs", () => {
    expect(externalIdSource.parse(" Home-Depot ")).toBe("home-depot");
    expect(externalIdSource.safeParse("home_depot").success).toBe(false);
  });

  it("allows only one identifier in each source/kind slot", () => {
    expect(
      externalIdInputs.safeParse([
        { source: "amazon", kind: "asin", externalId: "B000000001" },
        { source: "amazon", kind: "asin", externalId: "B000000002" },
      ]).success,
    ).toBe(false);
    expect(
      externalIdInputs.safeParse([
        { source: "home-depot", kind: "internet_number", externalId: "1" },
        { source: "home-depot", kind: "retailer_sku", externalId: "2" },
      ]).success,
    ).toBe(true);
  });

  it("derives Amazon product URLs from ASIN instead of storing them", () => {
    const asin = {
      source: "amazon",
      kind: "asin" as const,
      externalId: "B07NJSDBQ3",
      url: "https://www.amazon.com/some-stale-path",
    };
    expect(storedExternalIdUrl(asin)).toBeNull();
    expect(canonicalExternalIdUrl(asin)).toBe(
      "https://www.amazon.com/dp/B07NJSDBQ3",
    );
  });
});
