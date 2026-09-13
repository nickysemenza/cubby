import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProductPickerItemOut,
  ProductResolveCandidateOut,
  ProductResolveNamesOut,
} from "@cubby/schemas/product";
import { and, inArray, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { getProductPickerItemsByIds, productSearch } from "./crud";

const FUZZY_CANDIDATE_LIMIT = 3;

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
 * a contains search (the picker's `productSearch`, top {@link FUZZY_CANDIDATE_LIMIT})
 * only for the names that missed. Never writes — see `productResolveNamesInput`
 * for why the create stays a separate call.
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

  const results: ProductResolveNamesOut = [];
  for (const name of requested) {
    const shortcodes = exactShortcodesByKey.get(name.toLowerCase());
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
    const fuzzy = await productSearch(
      db,
      { nameFilter: name },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: FUZZY_CANDIDATE_LIMIT },
    );
    results.push({
      name,
      exact: false,
      candidates: fuzzy.data.map(toCandidate),
    });
  }
  return results;
};
