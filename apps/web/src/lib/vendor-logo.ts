// Pure vendor-logo helpers shared by the render path and seeding script. The
// generated manifest owns vendor identity; the name-derived slug below is only
// used when a vendor receives its first logo.

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

/**
 * Return a row's persisted vendor id only while its rendered name still matches.
 * Inline edits optimistically update the name before the server row refetches;
 * withholding the stale id avoids showing and linking the previous vendor.
 */
export function persistedVendorId<
  T extends { vendor: string | null; vendorId: string | null },
>(displayedName: string, row: T): string | null {
  return displayedName === row.vendor ? row.vendorId : null;
}
