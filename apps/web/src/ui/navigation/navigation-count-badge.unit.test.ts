import { describe, expect, it } from "vitest";

import { navigationCount } from "./navigation-count-badge";

describe("navigation list counts", () => {
  const counts = {
    product: 0,
    device: 7,
    usdaFoods: 0,
  };

  it("shows a loaded zero and leaves an absent optional count empty", () => {
    expect(navigationCount(counts, "product")).toBe(0);
    expect(navigationCount(counts, "device")).toBe(7);
    expect(navigationCount(counts, "vendorAccount")).toBeUndefined();
    expect(navigationCount(undefined, "product")).toBeUndefined();
  });

  it("shows USDA only when the upstream count was available", () => {
    expect(navigationCount(counts, "usdaFood")).toBeUndefined();
    expect(
      navigationCount({ ...counts, usdaFoodsAvailable: false }, "usdaFood"),
    ).toBeUndefined();
    expect(
      navigationCount({ ...counts, usdaFoodsAvailable: true }, "usdaFood"),
    ).toBe(0);
  });
});
