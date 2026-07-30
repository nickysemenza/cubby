// Vendor brand-logo identity: the pure string → asset-key mapping shared by the
// render path (`VendorMark`, via `~/lib/vendor-logo-lookup`) and the seeding
// script (`scripts/seed-vendor-logos.ts`).
//
// The asset KEY on disk (R2's `vendors/<slug>.png`) is still derived from the
// vendor's NAME — that part never changed. What changed is the manifest that
// maps a vendor to that key: `vendor-logos.generated.ts` now keys by
// `Vendor.id`, not by a freshly computed name-slug, so renaming a vendor no
// longer orphans its uploaded logo (see `vendor-logo-lookup.ts`'s
// `vendorLogoSlug`). This module stays the single, alias-free place both sides
// derive a NAME's slug identically — the seeder still needs it to know which
// R2 object to write, and the lookup still needs it as the fallback for a
// vendor id that predates the last seed run.

/**
 * R2 key prefix for vendor logos. Deliberately outside `R2_KEY_PREFIX`
 * (`cubby-dev`/`cubby-prod`): these are environment-independent static assets
 * shared by dev and prod, unlike per-environment entity images.
 */
export const VENDOR_LOGO_PREFIX = "vendors";

/** Strip diacritics so "Häfele" slugs to "hafele", not "h-fele". */
const deaccent = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Stable asset slug for a vendor string: deaccented, lowercased, with every run
 * of non-alphanumerics collapsed to a single hyphen ("B&H" → "b-h").
 */
export function vendorSlug(vendor: string): string {
  return deaccent(vendor)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Fallback mark for a vendor with no logo — the initials of the first two words
 * ("Direct Tools Outlet" → "DT"), or the first two letters of a single-word
 * vendor ("Zoro" → "ZO"). Most vendors are one-off local suppliers with a single
 * charge and no `website`, so this is the common path, not an edge case.
 */
export function vendorMonogram(vendor: string): string {
  const words = deaccent(vendor)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  const [first, second] = words;
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0]}${second[0]}`.toUpperCase();
}
