import { describe, expect, it } from "vitest";
import {
  mobileInventoryPrefixesForTest,
  resolveMobileRoute,
} from "./mobile-route-descriptor";

describe("mobile route descriptors", () => {
  it.each([
    ["/", "today"],
    ["/inventory", "inventory"],
    ["/products/PRD-TEST", "inventory"],
    ["/locations/new", "inventory"],
    ["/collections/CLR-TEST", "inventory"],
    ["/pantry-view", "inventory"],
    ["/scan", "scan"],
    ["/search", "search"],
    ["/recipes/RCP-TEST", "more"],
    ["/settings", "more"],
  ] as const)("assigns %s to %s", (pathname, tab) => {
    expect(resolveMobileRoute(pathname).tab).toBe(tab);
  });

  it("uses the owning list as a semantic deep-link fallback", () => {
    expect(resolveMobileRoute("/products/PRD-TEST")).toMatchObject({
      label: "Products",
      parentTo: "/products",
    });
    expect(resolveMobileRoute("/settings").parentTo).toBe("/");
  });

  it("marks only the intended viewport-owned flows immersive", () => {
    expect(resolveMobileRoute("/scan").presentation).toBe("immersive");
    expect(resolveMobileRoute("/inventory/session").presentation).toBe(
      "immersive",
    );
    expect(resolveMobileRoute("/products/PRD-TEST").presentation).toBe(
      "standard",
    );
  });

  it("keeps every declared inventory domain owned by the Inventory tab", () => {
    for (const prefix of mobileInventoryPrefixesForTest) {
      expect(resolveMobileRoute(`${prefix}/deep-link`).tab, prefix).toBe(
        "inventory",
      );
    }
  });

  it("still returns complete chrome metadata for utility routes", () => {
    expect(resolveMobileRoute("/future-household-utility")).toEqual({
      label: "Future Household Utility",
      parentTo: "/",
      tab: "more",
      presentation: "standard",
    });
  });
});
