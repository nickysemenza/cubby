// Vendor brand-logo identity: the pure string → asset-key mapping shared by the
// render path (`VendorMark`) and the seeding script (`scripts/seed-vendor-logos.ts`).
//
// `Expense.vendor` is free text, so there is no id to key an asset off — the
// vendor string itself is the key. Both sides MUST derive it the same way or the
// generated manifest and the runtime lookup silently disagree, which is why this
// lives in one alias-free module instead of being reimplemented per call site.

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
 * vendor ("Zoro" → "ZO"). 45 of the ledger's 67 vendors appear exactly once and
 * are one-off local suppliers, so this is the common path, not an edge case.
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
