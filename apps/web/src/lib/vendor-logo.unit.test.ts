import { describe, expect, it } from "vitest";
import { vendorMonogram, vendorSlug } from "./vendor-logo";
import { VENDOR_LOGO_BY_ID } from "./vendor-logos.generated";

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
    // This is the property that lets the manifest store a slug once (at seed
    // time) while the render path's fallback recomputes it fresh from the
    // vendor's current name: if `vendorSlug` weren't idempotent, comparing a
    // stored slug against a freshly computed one would be comparing two
    // different things even when nothing had changed.
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

  it("every manifest value is exactly what vendorSlug produces from itself", () => {
    // Catches a seeder that accidentally writes a vendor's NAME or ID into the
    // manifest's value slot instead of its slug — a mistake `vendorSlug`'s
    // idempotence otherwise makes invisible to a naive equality check.
    for (const slug of Object.values(VENDOR_LOGO_BY_ID)) {
      expect(vendorSlug(slug)).toBe(slug);
    }
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
