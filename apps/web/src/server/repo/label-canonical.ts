/**
 * Canonical-key normalization for the free-text brand labels nothing constrains
 * on write — `Product.manufacturer` today, `Vendor.name` if it ever needs it.
 *
 * Two consumers, one key: the Problems detectors
 * (`problems/detectors-label-variants.ts`) REPORT rows whose labels collapse to
 * the same key, and {@link resolveEstablishedManufacturer} PREVENTS new ones by
 * snapping an incoming spelling onto the one already in use. They must agree by
 * construction — a create path normalizing on a looser key than the detector
 * reports on would mint drift the page then complains about, and the reverse
 * would report drift the create path believes it already fixed.
 */

import { asc, type SQLWrapper, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

/**
 * Canonical form of a brand label: lowercase, without a leading "The", without
 * a trailing `.com` / `Inc` / `LLC` / `Co`, and with every non-alphanumeric
 * character dropped.
 *
 * That last step is what collapses `Lowe's`→`lowes`, `Bob s Red Mill`→
 * `bobsredmill` and `Home  Depot`→`homedepot` in one rule, rather than needing
 * a case for apostrophes, one for double spaces and one for hyphens.
 *
 * Takes any SQL expression, not just a column, so a constant can be run through
 * the same normalization it's being compared against.
 */
export const canonicalLabelKey = (value: SQLWrapper) => sql`
  regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(${value})), '^the\\s+', ''),
      '(\\.com|,?\\s+(inc|llc|co)\\.?)$', ''),
    '[^a-z0-9]', '', 'g')`;

/**
 * The spelling of `manufacturer` already established on live products, or the
 * caller's own spelling when the brand is new here.
 *
 * **Why creates snap and edits don't.** The drift this kills is mechanical:
 * Home Depot renders brand names in caps, so an HD-sourced import mints `RYOBI`
 * / `DEWALT` / `BUCKET BOSS` while the same brand arrives title-case from Amazon
 * and from hand entry — 19 split brands across 60 products on the live ledger
 * before the backfill. An importer has no opinion about capitalization, so
 * deferring to the established spelling always beats what it happened to
 * scrape. A person editing the field in the UI DOES have an opinion, so
 * `updateProduct` is deliberately not wired to this: renaming `Ryobi` →
 * `RYOBI` on purpose has to be possible, and a create path that snapped edits
 * too would silently revert it. The detector remains the backstop for whatever
 * an edit splits.
 *
 * Ties go alphabetically, matching the detector's canonical pick, so both
 * agree on which spelling is "the" one when no majority exists.
 *
 * Snapping can turn a create that used to succeed into a
 * `PRODUCT_ALREADY_EXISTS` — `Drill`/`RYOBI` and `Drill`/`Ryobi` are distinct
 * under the `Product_name_manufacturer_key` unique index until the spellings
 * agree. That's the point: they were always the same product, and
 * `throwIfDuplicateProduct` already renders that collision as a clear message.
 */
export const resolveEstablishedManufacturer = async (
  db: Database | DrizzleTransaction,
  manufacturer: string,
): Promise<string> => {
  // Nothing to match on, and no key to match with — `canonicalLabelKey('')` is
  // `''`, which would match every all-punctuation label rather than none.
  if (manufacturer.trim() === "") return manufacturer;

  const [established] = await unwrapDb(db)
    .select({ manufacturer: product.manufacturer })
    .from(product)
    .where(
      sql`${notDeleted(product)} AND ${canonicalLabelKey(product.manufacturer)} = ${canonicalLabelKey(sql`${manufacturer}`)}`,
    )
    .groupBy(product.manufacturer)
    .orderBy(sql`count(*) DESC`, asc(product.manufacturer))
    .limit(1);

  return established?.manufacturer ?? manufacturer;
};
