/**
 * Inventory valuation: live computation and the published read projection.
 *
 * An entry's valuation is its amount routed to money through the product's
 * unit-mapping graph — not `amount.value × price`. The graph is what makes
 * "4 roll" of a four-pack worth one pack rather than four.
 * {@link loadInventoryValuations} prices specific rows for background compute
 * and explicit live reports. Ordinary reads and mutation read-backs use
 * {@link loadStoredInventoryValuations}, retaining the published value until
 * the background wave completes (ADR 0021). {@link inventoryValuationSql}
 * hands a computed map back to SQL for reports that price on read.
 *
 * A repo helper rather than a service on purpose — it is data access plus a
 * call into lib compute, and a `*.service.ts` here would be the empty
 * pass-through the boundary rule forbids (`price-sync.ts` is the precedent).
 */

import type { InventoryId, ProductId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { inventoryValuationFacts } from "@cubby/schemas/inventory-fields";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { and, type AnyColumn, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { z } from "zod";

import { computeInventoryValuations } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { inventoryEntry, product } from "~/server/db/schema";
import { loadExactEffectivePrices } from "~/server/domains/product/repo/pricing";
import { getProductUnitMappingsByProductIds } from "~/server/domains/product/repo/unit-mappings";
import { storedDerivedSql } from "~/server/generic/derived/repo/read";

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
const loadValuationGraphs = async (
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
        id: parseShortcodeFor("product", row.shortcode),
        unitMappings: storedMappings[row.id] ?? [],
        food: null,
        // Valuation is weight/price conversions only; a label override only
        // ever adds nutrient edges, irrelevant here — and this query doesn't
        // load the column anyway.
        labelNutrition: null,
        price: exactPrices.get(row.id) ?? null,
      }),
    ]),
  );
};

const storedValuationColumn = sql<
  number | null
>`${storedDerivedSql("inventory", "valuation", inventoryEntry.id)}`;

/** The columns valuing one inventory row needs. */
export interface InventoryValuationRow {
  id: InventoryId;
  productId: ProductId;
  amountValue: number;
  amountUnit: string;
}

/** Entry id → computed valuation; `null` when there is no path from the unit to money. */
export type InventoryValuations = ReadonlyMap<InventoryId, number | null>;

/**
 * Value the given rows against their products' current graphs: one graph load
 * for all products, one batched WASM call per product. A row whose product is
 * missing or soft-deleted values at `null`, the honest answer.
 */
const prepareInventoryValuations = async (
  db: Database | DrizzleTransaction,
  rows: readonly InventoryValuationRow[],
) => {
  const byProduct = new Map<ProductId, InventoryValuationRow[]>();
  for (const row of rows) {
    const group = byProduct.get(row.productId) ?? [];
    group.push(row);
    byProduct.set(row.productId, group);
  }
  const graphs = await loadValuationGraphs(db, [...byProduct.keys()]);
  const valuations = new Map<InventoryId, number | null>();
  for (const [productId, group] of byProduct) {
    const values = computeInventoryValuations(
      group.map((row) => ({ value: row.amountValue, unit: row.amountUnit })),
      graphs.get(productId) ?? [],
    );
    group.forEach((row, index) => {
      valuations.set(row.id, values[index] ?? null);
    });
  }
  return { valuations, graphs };
};

/** The drain captures the very graphs used by the same batched calculation. */
export const loadInventoryValuationFacts = async (
  db: Database | DrizzleTransaction,
  rows: readonly InventoryValuationRow[],
): Promise<
  ReadonlyMap<InventoryId, z.output<typeof inventoryValuationFacts>>
> => {
  const { valuations, graphs } = await prepareInventoryValuations(db, rows);
  return new Map(
    rows.map((row) => [
      row.id,
      inventoryValuationFacts.parse({
        value: valuations.get(row.id) ?? null,
        evidence: {
          amount: { value: row.amountValue, unit: row.amountUnit },
          unitMappings: graphs.get(row.productId) ?? [],
        },
      }),
    ]),
  );
};

export const loadInventoryValuations = async (
  db: Database | DrizzleTransaction,
  rows: readonly InventoryValuationRow[],
): Promise<InventoryValuations> =>
  (await prepareInventoryValuations(db, rows)).valuations;

/** Attach each row's computed valuation, for mappers that read `entry.valuation`. */
export const attachInventoryValuations = <T extends { id: InventoryId }>(
  entries: readonly T[],
  valuations: InventoryValuations,
): Array<T & { valuation: number | null }> =>
  entries.map((entry) => ({
    ...entry,
    valuation: valuations.get(entry.id) ?? null,
  }));

/**
 * A computed valuation map as a SQL scalar for `idColumn`'s row, so the list's
 * `ORDER BY`, `WHERE` and `SUM` see exactly the figure the mappers display.
 * The map travels as ONE jsonb parameter (`{ "<uuid>": 12.5 | null }`) and each
 * row does an O(1) key lookup; no bound value is a `Column`, so this survives
 * the relational-query layer's alias rewriting untouched.
 */
export const inventoryValuationSql = (
  valuations: InventoryValuations,
  idColumn: AnyColumn | SQL,
): SQL<number | null> =>
  sql<
    number | null
  >`((${JSON.stringify(Object.fromEntries(valuations))}::jsonb ->> (${idColumn})::text)::double precision)`;

/**
 * Published valuations (ADR 0021) for live inventory rows, or for `ids`. A row
 * whose value is not yet computed reads `null`, the same honest unknown a
 * missing price gives; its stale mark is pending in the drain.
 */
export const loadStoredInventoryValuations = async (
  db: Database | DrizzleTransaction,
  ids?: readonly InventoryId[],
): Promise<InventoryValuations> => {
  if (ids?.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({ id: inventoryEntry.id, valuation: storedValuationColumn })
    .from(inventoryEntry)
    .where(
      ids
        ? and(inArray(inventoryEntry.id, [...ids]), notDeleted(inventoryEntry))
        : notDeleted(inventoryEntry),
    );
  return new Map(rows.map((row) => [row.id, row.valuation]));
};
