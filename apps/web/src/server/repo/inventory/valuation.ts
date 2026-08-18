/**
 * A Product's conversion graph, loaded for valuation.
 *
 * `InventoryEntry.valuation` is the entry's amount routed to money through the
 * product's unit-mapping graph — not `amount.value × price`. The graph is what
 * makes "4 roll" of a four-pack worth one pack rather than four, so every write
 * path that stores a valuation has to load it. This module is that load, kept
 * in one place: four hand-copied `priceMap` blocks across `bulk.ts` and
 * `crud.ts` used to each rebuild half of it.
 *
 * A repo helper rather than a service on purpose — it is data access plus a
 * call into lib compute, and a `*.service.ts` here would be the empty
 * pass-through the boundary rule forbids (`price-sync.ts` is the precedent).
 */

import type { ProductId } from "@cubby/schemas/identifiers";
import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { and, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { product } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { loadExactEffectivePrices } from "~/server/repo/product/pricing";
import { getProductUnitMappingsByProductIds } from "~/server/repo/product/unit-mappings";

/**
 * Every requested Product's valuation graph: its stored conversion rows plus
 * the synthesized `1 each = $price` edge, keyed by product id. Products that
 * are missing or soft-deleted are simply absent from the map — a caller that
 * defaults to `[]` values them at `null`, which is the honest answer.
 *
 * **`food: null` is a deliberate scope limit.** USDA-derived edges (portions,
 * servings, nutrients) live behind a service binding and cannot be fetched
 * inside a write transaction, and most of these call sites are mid-write. So a
 * gram amount on a product whose only gram bridge is a USDA portion values at
 * `null` here, even though recipe costing — which does have the food loaded —
 * can price the same amount. Widening this means loading food OUTSIDE the
 * transaction and threading it in, not calling USDA from within one.
 *
 * The money edge is built from `loadExactEffectivePrices`, the UNROUNDED
 * effective unit price — the cent-rounded `pricing.effectivePrice` would leak
 * its rounding into every multiplied valuation.
 */
export const loadValuationGraphs = async (
  db: Database | DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<ReadonlyMap<ProductId, UnitMapping[]>> => {
  const ids = uniq([...productIds]);
  if (ids.length === 0) return new Map();

  const rows = await unwrapDb(db).query.product.findMany({
    where: and(inArray(product.id, ids), notDeleted(product)),
    // `shortcode` alongside id/price because `getAllUnitMappingsFromProduct`
    // stamps it into the synthesized edge's provenance — handing it a uuid
    // there is a trap this repo has closed before.
    columns: { id: true, shortcode: true, price: true },
  });
  if (rows.length === 0) return new Map();

  const [exactPrices, storedMappings] = await Promise.all([
    loadExactEffectivePrices(db, rows),
    getProductUnitMappingsByProductIds(
      db,
      rows.map((row) => row.id),
    ),
  ]);

  return new Map(
    rows.map((row) => [
      row.id,
      getAllUnitMappingsFromProduct({
        id: unsafeProductShortcode(row.shortcode),
        unitMappings: storedMappings[row.id] ?? [],
        food: null,
        price: row.price,
        pricing: { effectivePrice: exactPrices.get(row.id) ?? null },
      }),
    ]),
  );
};

/** {@link loadValuationGraphs} for a single Product; `[]` when it has none. */
export const loadValuationGraph = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
): Promise<UnitMapping[]> =>
  (await loadValuationGraphs(db, [productId])).get(productId) ?? [];
