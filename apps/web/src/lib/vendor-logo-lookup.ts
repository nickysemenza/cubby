// Render-path resolver for vendor logos. Split out of `vendor-logo.ts` because
// that module must stay import-free (the seeding script pulls it over a
// relative path, outside the app's module graph), while this one needs to
// import both the pure slug logic and the generated manifest.

import { vendorSlug } from "~/lib/vendor-logo";
import { VENDOR_LOGO_BY_ID } from "~/lib/vendor-logos.generated";

/**
 * Resolves the R2 logo slug for a vendor.
 *
 * The id is authoritative and rename-proof: once a vendor has been seeded,
 * `VENDOR_LOGO_BY_ID[vendorId]` keeps returning its logo no matter what its
 * `name` becomes, because the manifest was keyed at seed time by id, not by a
 * freshly recomputed name-slug. Falls through to the name-derived slug when
 * `vendorId` is present but has no manifest entry — a vendor created (or a
 * logo seeded) after the last run of `seed-vendor-logos.ts` has an id the
 * manifest doesn't know about yet, and the name-slug is the best available
 * guess until the next seed. That fall-through is what makes threading an id
 * through a call site strictly monotone: every site becomes as-good-or-better
 * than the name-only lookup it replaces, never worse.
 *
 * The returned slug is not guaranteed to actually have a logo in R2 when it
 * comes from the fallback branch — callers still check membership against
 * `VENDOR_LOGO_SLUGS` (see `hasVendorLogo` in `vendor-cell.tsx`) the same way
 * regardless of which branch produced the slug.
 */
export function vendorLogoSlug(
  vendor: string,
  vendorId?: string | null,
): string {
  const byId = vendorId ? VENDOR_LOGO_BY_ID[vendorId] : undefined;
  return byId ?? vendorSlug(vendor);
}

/**
 * The vendor id to thread into a logo lookup for a row whose vendor NAME is
 * only known through an optimistic/display value — returns `row.vendorId`
 * only while `displayedName` still matches `row.vendor`.
 *
 * This exists for the two call sites where the rendered name can be an
 * `EditableEntityCell` optimistic value that's ahead of the row's own fields:
 * during the optimistic window after picking a new vendor, `displayedName` is
 * the NEW vendor's name but `row.vendorId` (from the last server response) is
 * still the OLD vendor's id. Passing that stale id straight through would
 * render the previous brand's logo under the new vendor's name — worse than
 * the monogram this function makes it fall back to instead. Once the mutation
 * settles and `row` refetches, the names reconverge and the real id flows
 * through again.
 */
export function persistedVendorId<
  T extends { vendor: string | null; vendorId: string | null },
>(displayedName: string, row: T): string | null {
  return displayedName === row.vendor ? row.vendorId : null;
}
