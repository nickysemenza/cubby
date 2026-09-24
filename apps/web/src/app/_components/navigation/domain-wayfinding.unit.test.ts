import { describe, expect, it } from "vitest";

import { domainForEntity, domainForRoute } from "./domain-wayfinding";

describe("Porcelain Transit domain wayfinding", () => {
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
