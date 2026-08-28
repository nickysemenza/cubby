import { describe, expect, it } from "vitest";

import { persistedVendorId, vendorMonogram } from "./vendor-logo";

describe("persistedVendorId", () => {
  const row = { vendor: "Amazon", vendorId: "VEN-2345" };

  it("returns the id while the displayed and persisted names match", () => {
    expect(persistedVendorId("Amazon", row)).toBe("VEN-2345");
  });

  it("withholds a stale id during an optimistic vendor edit", () => {
    expect(persistedVendorId("Home Depot", row)).toBeNull();
  });
});

describe("vendorMonogram", () => {
  it("takes initials of the first two words", () => {
    expect(vendorMonogram("Direct Tools Outlet")).toBe("DT");
  });

  it("takes the first two letters of a single-word vendor", () => {
    expect(vendorMonogram("Zoro")).toBe("ZO");
  });

  it("falls back to a bare '?' for an empty/unparseable name", () => {
    expect(vendorMonogram("   ")).toBe("?");
  });
});
