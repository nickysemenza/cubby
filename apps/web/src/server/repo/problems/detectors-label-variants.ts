/**
 * Spelling-variant detectors for two name columns nothing normalizes on write:
 * the free-text `Product.manufacturer` and the `Vendor.name` roster.
 *
 * Neither column is an enum, and manufacturer shouldn't be: typing it would put
 * "create an entity first" in front of a one-off brand. `Vendor` IS an entity,
 * but `findOrCreateVendor` matches its name EXACTLY, which has the same effect —
 * the cost either way is that the same name can be entered two ways, which an
 * exact-match filter then splits into two picklist rows (or, for vendors, two
 * roster rows splitting one vendor's spend).
 *
 * Manufacturer creates now snap to the established spelling
 * (`resolveEstablishedManufacturer`, sharing this file's key), so these
 * detectors are the backstop rather than the only line of defence: they still
 * catch what a deliberate UI edit splits, what predates the snap, and — for
 * vendors, which have no snap — everything.
 *
 * **Why a canonical key and not fuzzy matching.** Trigram similarity is
 * unusable here: at `similarity > 0.3` it flags 13 pairs on the live ledger and
 * every one is a false positive — `Ace Hardware`/`DK Hardware`,
 * `Home Depot`/`Office Depot`, `Tool Nirvana`/`Tool Nut`, `Flow Form
 * Plumbing`/`Lutz Plumbing`. Brand names share industry nouns, so the score
 * measures the shared noun rather than the part that distinguishes them, and
 * the real drift (`Amazon.com` at 0.636) doesn't separate from the noise
 * (`Festool`/`Festool Recon` at 0.571). A detector that cries wolf on its first
 * run teaches you to ignore the page.
 *
 * `canonicalLabelKey` is exact instead: two spellings collide only if they are
 * the same name typed differently. It found 2 real manufacturer bugs
 * (`Ryobi`/`RYOBI`, `Bob's Red Mill`/`Bob s Red Mill`) on the live DB, and
 * later the 19-variant / 60-product casing split the snap now prevents. It
 * cannot catch a hand typo (`Harbor Frieght`) — that needs an edit distance,
 * which needs `fuzzystrmatch`.
 */

import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { ProblemItem } from "@cubby/schemas/problems";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { type Column, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product, purchase, vendor } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { canonicalLabelKey } from "~/server/repo/label-canonical";

type SpellingVariantRow = {
  value: string;
  count: number;
  sampleId: string;
  canonical: string;
  canonicalCount: number;
  canonicalSampleId: string;
};

/**
 * Groups of spellings that share a canonical key, as one row per NON-canonical
 * spelling.
 *
 * Canonical = the spelling used most, ties broken alphabetically so the pick is
 * deterministic. A tie means there is no majority (`Bob's Red Mill` 1 vs `Bob s
 * Red Mill` 1) and the winner is arbitrary — the row carries both counts so
 * that's visible rather than hidden, and choosing between them is the human's
 * job.
 *
 * "Used most" needs a per-caller `weight`, because what backs a spelling isn't
 * the same thing in both tables. A manufacturer spelling is backed by the
 * PRODUCTS carrying it, so `count(*)` over the group is the measure. A vendor
 * name is unique among live rows (`Vendor_name_key`), so counting rows there
 * would return 1 for every spelling — no majority ever, and the canonical pick
 * would silently degrade to alphabetical order, which is not just arbitrary but
 * COLLATION-dependent. A vendor spelling is backed by the charges pointing at
 * it, which is the signal that actually decided the one real case: `B&H Photo`
 * (4 charges) was the row to keep, `B&H` (1) the row to retire.
 *
 * `sampleId` is one record bearing the variant, so the Problems card can link
 * somewhere; `min(id)` makes it stable across runs rather than picking a
 * different row each scan. `canonicalSampleId` is the same thing for the winning
 * spelling — selected unconditionally because it is one more `first_value` over
 * the window that is already there, and only a caller whose rows are real
 * entities (`findDuplicateVendors`) has any use for it. The manufacturer caller
 * narrows it away in its return type, and `problemsFastSchema` strips it from
 * that key's wire shape.
 */
const findSpellingVariants = async (
  db: Database,
  table: typeof product | typeof vendor,
  column: Column,
  {
    extraWhere = sql`TRUE`,
    weight = sql`count(*)`,
  }: { extraWhere?: SQL; weight?: SQL } = {},
): Promise<SpellingVariantRow[]> => {
  const res = await getDb(db).execute<SpellingVariantRow>(sql`
    WITH spellings AS (
      SELECT ${column} AS value,
             ${weight}::int AS count,
             (array_agg(shortcode ORDER BY id::text))[1] AS "sampleId",
             ${canonicalLabelKey(column)} AS key
      FROM ${table}
      WHERE "deletedAt" IS NULL
        AND ${column} IS NOT NULL
        AND btrim(${column}) <> ''
        AND ${extraWhere}
      GROUP BY ${column}
    ),
    -- Only keys spelled more than one way are interesting; everything else is
    -- the overwhelming majority of rows and never reaches the window below.
    drifted AS (
      SELECT key FROM spellings GROUP BY key HAVING count(*) > 1
    ),
    ranked AS (
      SELECT s.*,
             first_value(s.value) OVER w AS canonical,
             first_value(s.count) OVER w AS "canonicalCount",
             first_value(s."sampleId") OVER w AS "canonicalSampleId"
      FROM spellings s
      INNER JOIN drifted d ON d.key = s.key
      WINDOW w AS (PARTITION BY s.key ORDER BY s.count DESC, s.value ASC)
    )
    SELECT value, count, "sampleId", canonical,
           "canonicalCount", "canonicalSampleId"
    FROM ranked
    WHERE value <> canonical
    ORDER BY "canonicalCount" DESC, count DESC, value ASC
  `);
  return res.rows;
};

/**
 * Product manufacturers spelled more than one way.
 *
 * `(unspecified)` is excluded: it's the deliberate not-a-brand sentinel
 * (`isUnspecifiedManufacturer` in ~/lib/manufacturer-utils) carried by 159 of
 * 381 products, and reporting it as a spelling would be noise.
 *
 * The comparison is on the CANONICAL key, not the raw string. A plain `<>` is
 * case-sensitive, so a `(Unspecified)` from a CSV import would survive the
 * exclusion — and then `canonicalLabelKey` would fold it onto the same `unspecified`
 * key as the 159 correctly-cased rows and report the sentinel as a spelling
 * variant. Comparing after normalization is immune to that by construction, and
 * covers spacing drift too; it's the same case-insensitive intent as
 * `isUnspecifiedManufacturer` and `ilike(product.manufacturer,
 * UNSPECIFIED_MANUFACTURER)` in product/lookup.ts.
 */
export const findManufacturerSpellingVariants = (
  db: Database,
): Promise<ProblemItem<"manufacturerSpellingVariants">[]> =>
  findSpellingVariants(db, product, product.manufacturer, {
    extraWhere: sql`${canonicalLabelKey(product.manufacturer)} <> ${canonicalLabelKey(sql`${UNSPECIFIED_MANUFACTURER}`)}`,
  }).then((rows) =>
    rows.map(({ canonicalSampleId: _canonicalSampleId, ...row }) => ({
      ...row,
      sampleId: parseShortcodeFor("product", row.sampleId),
    })),
  );

/**
 * Vendors on the roster whose names normalize to the same thing — `Amazon` /
 * `amazon` / `Amazon.com`.
 *
 * This replaces the deleted `findVendorSpellingVariants`, which read the old
 * free-text `Expense.vendor` column, and it is a genuinely different thing.
 * That detector could only ever REPORT drift, because there was no entity to
 * merge; these are two real `Vendor` rows, so this worklist has a fix —
 * `mergeVendors` (repo/vendor.ts), which also folds any charges the two vendors
 * hold under the same order id.
 *
 * The gap it closes: `findOrCreateVendor` matches names EXACTLY on the write
 * path (deliberately — folding case there would silently merge a real `3M` /
 * `3m` distinction on first sight), so every importer that meets a new spelling
 * mints a new row and nothing else notices. As of the split's backfill there are
 * 0 such pairs across 114 vendors; this exists to keep it that way.
 *
 * `sampleId` is the VARIANT's own vendor id, so the card links to the row a merge
 * would retire — not to some expense that merely mentions it; `canonicalSampleId`
 * is the row it would be folded INTO, which is what `mergeVendors` needs as its
 * `keepId` (`canonical` is only a name).
 *
 * It catches SPELLING drift, not ABBREVIATION drift: `B&H` and `B&H Photo`
 * normalize to different keys (`bh` / `bhphoto`) and are not reported. That pair
 * was real, and merging it was a human judgement no key could have made.
 *
 * `count` is LIVE CHARGES, not roster rows — see the `weight` note on
 * `findSpellingVariants` for why counting rows here can't produce a majority.
 * `sum(...)` rather than a bare scalar because the group-by still demands an
 * aggregate; each group is exactly one vendor row, so the sum IS that row's
 * charge count.
 */
export const findDuplicateVendors = (
  db: Database,
): Promise<ProblemItem<"duplicateVendors">[]> =>
  findSpellingVariants(db, vendor, vendor.name, {
    weight: sql`sum((
      SELECT count(*) FROM ${purchase}
      WHERE ${purchase.vendorId} = ${vendor.id}
        AND ${purchase.deletedAt} IS NULL
    ))`,
  }).then((rows) =>
    rows.map((row) => ({
      ...row,
      sampleId: parseShortcodeFor("vendor", row.sampleId),
      canonicalSampleId: parseShortcodeFor("vendor", row.canonicalSampleId),
    })),
  );
