import { describe, expect, it } from "vitest";

import { persistedVendorId } from "./vendor-logo";

describe("persistedVendorId", () => {
  const row = { vendor: "Amazon", vendorId: "VEN-2345" };

  it("returns the id while the displayed and persisted names match", () => {
    expect(persistedVendorId("Amazon", row)).toBe("VEN-2345");
  });

  it("withholds a stale id during an optimistic vendor edit", () => {
    expect(persistedVendorId("Home Depot", row)).toBeNull();
  });
});
