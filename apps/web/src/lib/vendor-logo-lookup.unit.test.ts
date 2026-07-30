import { describe, expect, it } from "vitest";
import { persistedVendorId, vendorLogoSlug } from "./vendor-logo-lookup";
import { VENDOR_LOGO_BY_ID } from "./vendor-logos.generated";

// Driven off a live manifest entry rather than a hardcoded id/slug pair, so
// this survives a re-seed that drops or renumbers vendors — any entry works,
// this just needs one to exist.
const [SEEDED_ID, SEEDED_SLUG] = Object.entries(VENDOR_LOGO_BY_ID)[0] ?? [];
if (!SEEDED_ID || !SEEDED_SLUG) {
  throw new Error(
    "VENDOR_LOGO_BY_ID is empty — vendor-logo-lookup.unit.test.ts needs at least one seeded entry to test against.",
  );
}

describe("vendorLogoSlug", () => {
  it("resolves by id first, ignoring the name entirely", () => {
    // The whole point: an id hit is authoritative even when the name it's
    // paired with is stale or simply wrong.
    expect(vendorLogoSlug("Totally Different Name", SEEDED_ID)).toBe(
      SEEDED_SLUG,
    );
  });

  it("falls through to the name-slug when vendorId is present but unseeded", () => {
    // A vendor id that predates the last seed run (or was never seeded) has
    // no manifest entry — this is what keeps threading an id through a call
    // site monotone rather than a regression.
    expect(vendorLogoSlug("Amazon", "not-a-real-manifest-id")).toBe("amazon");
  });

  it("falls through to the name-slug when no vendorId is given", () => {
    expect(vendorLogoSlug("Amazon")).toBe("amazon");
    expect(vendorLogoSlug("Amazon", null)).toBe("amazon");
    expect(vendorLogoSlug("Amazon", undefined)).toBe("amazon");
  });
});

describe("persistedVendorId", () => {
  const row = { vendor: "Amazon", vendorId: "vendor-amazon-id" };

  it("returns the row's vendorId while the displayed name still matches", () => {
    expect(persistedVendorId("Amazon", row)).toBe("vendor-amazon-id");
  });

  it("withholds the id once the displayed name diverges from the row", () => {
    // The optimistic-rename case: `displayedName` is the newly picked
    // vendor's name, but `row.vendorId` (from the last server response) is
    // still the PREVIOUS vendor's id. Returning it here would render the old
    // brand's logo under the new vendor's name — worse than a monogram.
    expect(persistedVendorId("Home Depot", row)).toBeNull();
  });

  it("returns null when the row itself has no vendorId, even if names match", () => {
    expect(
      persistedVendorId("Amazon", { vendor: "Amazon", vendorId: null }),
    ).toBeNull();
  });
});
