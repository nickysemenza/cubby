/**
 * Spelling-variant detector for the free-text `Product.manufacturer` column.
 *
 * The column is not an enum, and shouldn't be: typing it would put "create an
 * entity first" in front of a one-off brand. The cost of leaving it free text
 * is that the same name can be entered two ways, which an exact-match filter
 * then splits into two picklist rows. This catches that drift rather than
 * preventing it.
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
 * The key below is exact instead: two spellings collide only if they are the
 * same name typed differently. It found 2 real manufacturer bugs
 * (`Ryobi`/`RYOBI`, `Bob's Red Mill`/`Bob s Red Mill`) on the live DB. It
 * cannot catch a hand typo (`Harbor Frieght`) — that needs an edit distance,
 * which needs `fuzzystrmatch`.
 */

import type { LabelVariant } from "@cubby/schemas/problems";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { type Column, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

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
const canonicalKey = (value: SQLWrapper) => sql`
  regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(${value})), '^the\\s+', ''),
      '(\\.com|,?\\s+(inc|llc|co)\\.?)$', ''),
    '[^a-z0-9]', '', 'g')`;

/**
 * Groups of spellings that share a canonical key, as one row per NON-canonical
 * spelling.
 *
 * Canonical = the spelling used most, ties broken alphabetically so the pick is
 * deterministic. A tie means there is no majority (`Bob's Red Mill` 1 vs `Bob s
 * Red Mill` 1) and the winner is arbitrary — the row carries both counts so
 * that's visible rather than hidden, and choosing between them is the human's
 * job. This is a report, not a merge.
 *
 * `sampleId` is one record bearing the variant, so the Problems card can link
 * somewhere; `min(id)` makes it stable across runs rather than picking a
 * different row each scan.
 *
 * Only `findManufacturerSpellingVariants` calls this today — the sibling
 * `Expense.vendor` detector was removed once vendor became a real `Vendor` FK
 * with a partial-unique index, which makes that drift unrepresentable. Kept as
 * its own function (rather than inlined) so a second free-text brand column
 * can reuse it the same way without re-deriving the SQL.
 */
const findSpellingVariants = async (
  db: Database,
  table: typeof product,
  column: Column,
  extraWhere = sql`TRUE`,
): Promise<LabelVariant[]> => {
  const res = await getDb(db).execute<LabelVariant>(sql`
    WITH spellings AS (
      SELECT ${column} AS value,
             count(*)::int AS count,
             min(id::text) AS "sampleId",
             ${canonicalKey(column)} AS key
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
             first_value(s.count) OVER w AS "canonicalCount"
      FROM spellings s
      INNER JOIN drifted d ON d.key = s.key
      WINDOW w AS (PARTITION BY s.key ORDER BY s.count DESC, s.value ASC)
    )
    SELECT value, count, "sampleId", canonical, "canonicalCount"
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
 * exclusion — and then `canonicalKey` would fold it onto the same `unspecified`
 * key as the 159 correctly-cased rows and report the sentinel as a spelling
 * variant. Comparing after normalization is immune to that by construction, and
 * covers spacing drift too; it's the same case-insensitive intent as
 * `isUnspecifiedManufacturer` and `ilike(product.manufacturer,
 * UNSPECIFIED_MANUFACTURER)` in product/lookup.ts.
 */
export const findManufacturerSpellingVariants = (
  db: Database,
): Promise<LabelVariant[]> =>
  findSpellingVariants(
    db,
    product,
    product.manufacturer,
    sql`${canonicalKey(product.manufacturer)} <> ${canonicalKey(sql`${UNSPECIFIED_MANUFACTURER}`)}`,
  );
