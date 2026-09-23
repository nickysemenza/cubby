import { describe, expect, it } from "vitest";

import {
  DOMAIN_WAYFINDING,
  domainForEntity,
  domainForRoute,
  domainWayfinding,
} from "./domain-wayfinding";

describe("Porcelain Transit domain wayfinding", () => {
  it("keeps the five labels and semantic tokens durable", () => {
    expect(
      Object.values(DOMAIN_WAYFINDING).map((domain) => domain.label),
    ).toEqual(["Cook", "Pantry", "Plan", "House", "Finance"]);
    expect(domainWayfinding("pantry")).toMatchObject({
      accentToken: "--domain-pantry",
      surfaceToken: "--domain-pantry-surface",
    });
  });

  it.each([
    ["/recipes", "cook"],
    ["/ingredients/workbench", "cook"],
    ["/products/PROD-42", "pantry"],
    ["/inventory/session", "pantry"],
    ["/scan", "pantry"],
    ["/labels", "pantry"],
    ["/meals/shopping-list", "plan"],
    ["/projects/tools", "house"],
    ["/garden-workbench?mode=plan", "house"],
    ["/tools", "house"],
    ["/expenses/EXP-42?view=list", "finance"],
  ])("classifies %s as %s", (path, expected) => {
    expect(domainForRoute(path)).toBe(expected);
  });

  it("uses route boundaries so similarly prefixed utility paths do not inherit color", () => {
    expect(domainForRoute("/products-extra")).toBeNull();
    expect(domainForRoute("/unknown/route")).toBeNull();
    expect(domainForRoute("/")).toBeNull();
  });

  it("classifies Product with the Pantry/Inventory family", () => {
    expect(domainForEntity("product")).toBe("pantry");
    expect(domainForEntity("inventory")).toBe("pantry");
    expect(domainForEntity("expense")).toBe("finance");
    expect(domainForEntity("image")).toBeNull();
  });
});
