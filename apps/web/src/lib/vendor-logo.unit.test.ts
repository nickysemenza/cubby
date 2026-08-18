import { describe, expect, it } from "vitest";
import { persistedVendorId, vendorMonogram, vendorSlug } from "./vendor-logo";

describe("vendorSlug", () => {
  it("deaccents, lowercases, and hyphenates punctuation", () => {
    expect(vendorSlug("Häfele")).toBe("hafele");
    expect(vendorSlug("B&H Photo")).toBe("b-h-photo");
    expect(vendorSlug("Lowe's")).toBe("lowe-s");
  });

  it("collapses runs of non-alphanumerics and trims leading/trailing hyphens", () => {
    expect(vendorSlug("  Direct   Tools -- Outlet!! ")).toBe(
      "direct-tools-outlet",
    );
    expect(vendorSlug("***Zoro***")).toBe("zoro");
  });

  it("is idempotent — re-slugging an already-slugged string is a no-op", () => {
    // Stored slugs remain safe to normalize when a seed is refreshed.
    for (const name of [
      "Häfele",
      "B&H Photo",
      "Direct Tools Outlet",
      "eBay",
      "1stDibs",
    ]) {
      const once = vendorSlug(name);
      expect(vendorSlug(once)).toBe(once);
    }
  });
});

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
