import {
  parseShortcodeFor,
  type ProductId,
  productId,
} from "@cubby/schemas/identifiers";
import type {
  ProductPickerItemOut,
  ProductResolveCandidateOut,
  ProductResolveNamesOut,
} from "@cubby/schemas/product";
import { and, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb, notDeleted, unwrapDb } from "~/server/repo/database-helpers";

import { getProductPickerItemsByIds } from "./crud";

const FUZZY_CANDIDATE_LIMIT = 3;

const fuzzyMatchRowSchema = z.object({
  key: z.string(),
  id: productId,
  shortcode: z.string(),
});

const toCandidate = (
  item: ProductPickerItemOut,
): ProductResolveCandidateOut => ({
  id: item.id,
  name: item.name,
  manufacturer: item.manufacturer,
  category: item.category,
  price: item.price,
  coverImageUrl: item.coverImageUrl,
});

/**
 * Resolve receipt-line names to existing Products without creating any.
 *
 * One exact pass over `lower(name)` and aliases for every requested name, then
 * one batched contains search (same predicate as the picker's `productSearch`
 * `nameFilter`, top {@link FUZZY_CANDIDATE_LIMIT} per name) for every name that
 * missed — not a per-name round-trip. Never writes — see
 * `productResolveNamesInput` for why the create stays a separate call.
 */
export const resolveProductNames = async (
  db: Database,
  names: string[],
): Promise<ProductResolveNamesOut> => {
  const requested: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    requested.push(name);
  }
  if (requested.length === 0) return [];

  const keys = requested.map((name) => name.toLowerCase());
  // A JS array interpolated into sql`` becomes a row constructor, which
  // postgres rejects inside IN (...) — join the literals explicitly.
  const keyList = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  );
  const exactRows = await getDb(db).query.product.findMany({
    where: and(
      notDeleted(product),
      or(
        inArray(sql`lower(${product.name})`, keys),
        sql`EXISTS (SELECT 1 FROM unnest(${product.aliases}) AS alias WHERE lower(alias) IN (${keyList}))`,
      ),
    ),
    columns: { id: true, shortcode: true, name: true, aliases: true },
  });
  const exactShortcodesByKey = new Map<
    string,
    Set<ProductPickerItemOut["id"]>
  >();
  for (const row of exactRows) {
    for (const matchName of [row.name, ...row.aliases]) {
      const key = matchName.toLowerCase();
      if (!seen.has(key)) continue;
      const shortcodes =
        exactShortcodesByKey.get(key) ?? new Set<ProductPickerItemOut["id"]>();
      shortcodes.add(parseShortcodeFor("product", row.shortcode));
      exactShortcodesByKey.set(key, shortcodes);
    }
  }
  const exactItems = await getProductPickerItemsByIds(
    db,
    exactRows.map((row) => row.id),
  );
  // Picker rows come back in storage order; key them by public id.
  const itemByShortcode = new Map(exactItems.map((item) => [item.id, item]));

  // Same predicate `productSearch` builds for `nameFilter` (`product/crud.ts`
  // `formatSearchTerm` on name/notes, `alias ILIKE` on aliases) — no `%`/`_`
  // escaping there either, kept for parity. One batched LATERAL pass replaces
  // what used to be a `productSearch` round-trip (list + count + 3 hydration
  // queries) per missed name.
  const misses = requested.filter(
    (name) => !exactShortcodesByKey.get(name.toLowerCase())?.size,
  );
  // Per-key public-id candidate lists, in the same shape as
  // `exactShortcodesByKey` above — keyed by public id (not the internal db
  // id) so hydration below can reuse the exact-match path's `itemByShortcode`
  // pattern instead of a fragile positional zip against a second query.
  const fuzzyShortcodesByKey = new Map<string, ProductPickerItemOut["id"][]>();
  const fuzzyDbIds: ProductId[] = [];
  if (misses.length > 0) {
    const missKeys = misses.map((name) => name.toLowerCase());
    const missList = sql.join(
      missKeys.map((key) => sql`${key}`),
      sql`, `,
    );
    const fuzzyResult = await unwrapDb(db).execute(sql`
      SELECT m.key AS key, cand.id AS id, cand.shortcode AS shortcode
      FROM unnest(ARRAY[${missList}]::text[]) AS m(key)
      CROSS JOIN LATERAL (
        SELECT p.id, p.shortcode
        FROM "Product" p
        WHERE p."deletedAt" IS NULL AND (
          p.name ILIKE '%' || m.key || '%'
          OR p.notes ILIKE '%' || m.key || '%'
          OR EXISTS (
            SELECT 1 FROM unnest(p.aliases) AS alias
            WHERE alias ILIKE '%' || m.key || '%'
          )
        )
        ORDER BY p.name ASC, p.shortcode ASC, p.id ASC
        LIMIT ${FUZZY_CANDIDATE_LIMIT}
      ) cand
    `);
    // Rows for a given key arrive in the per-key ORDER BY/LIMIT above, so
    // appending in encountered order reconstructs that per-key ranking.
    for (const row of z.array(fuzzyMatchRowSchema).parse(fuzzyResult.rows)) {
      const shortcode = parseShortcodeFor("product", row.shortcode);
      const shortcodes = fuzzyShortcodesByKey.get(row.key) ?? [];
      shortcodes.push(shortcode);
      fuzzyShortcodesByKey.set(row.key, shortcodes);
      fuzzyDbIds.push(row.id);
    }
  }
  const fuzzyItems = await getProductPickerItemsByIds(db, fuzzyDbIds);
  const itemByFuzzyShortcode = new Map(
    fuzzyItems.map((item) => [item.id, item]),
  );

  const results: ProductResolveNamesOut = [];
  for (const name of requested) {
    const key = name.toLowerCase();
    const shortcodes = exactShortcodesByKey.get(key);
    if (shortcodes && shortcodes.size > 0) {
      results.push({
        name,
        exact: true,
        candidates: [...shortcodes]
          .map((shortcode) => itemByShortcode.get(shortcode))
          .filter((item): item is ProductPickerItemOut => item !== undefined)
          .map(toCandidate),
      });
      continue;
    }
    results.push({
      name,
      exact: false,
      candidates: (fuzzyShortcodesByKey.get(key) ?? [])
        .map((shortcode) => itemByFuzzyShortcode.get(shortcode))
        .filter((item): item is ProductPickerItemOut => item !== undefined)
        .map(toCandidate),
    });
  }
  return results;
};
