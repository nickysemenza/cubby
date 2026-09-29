/**
 * A product's stored conversion rows, read on their own, plus the conversion
 * between a row's `aValue/aUnit/bValue/bUnit` columns and the `{ a, b }`
 * amounts the rest of the app speaks.
 *
 * Lives outside `product/crud.ts` to keep the module graph acyclic: the
 * inventory valuation path (`repo/inventory/valuation.ts`) needs this read to
 * build a product's unit graph, and `product/crud.ts` imports inventory code.
 */

import type { Amount } from "@cubby/schemas/codec";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { and, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productUnitMappings } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

interface UnitMappingColumns {
  aValue: number;
  aUnit: string;
  bValue: number;
  bUnit: string;
}

/** The `{ a, b }` amounts of a stored unit-mapping row. */
export const unitMappingSides = (row: UnitMappingColumns) =>
  ({
    a: { value: row.aValue, unit: row.aUnit },
    b: { value: row.bValue, unit: row.bUnit },
  }) satisfies { a: Amount; b: Amount };

/** The columns to write for a `{ a, b }` pair; the inverse of {@link unitMappingSides}. */
export const unitMappingColumns = (mapping: {
  a: Amount;
  b: Amount;
}): UnitMappingColumns => ({
  aValue: mapping.a.value,
  aUnit: mapping.a.unit,
  bValue: mapping.b.value,
  bUnit: mapping.b.unit,
});

/**
 * Stored conversion rows per product uuid, deliberately WITHOUT provenance.
 *
 * `sourceMetadata` names a product by its public shortcode (the schema's field
 * is `productShortcode`), and a repo keyed on uuids has no shortcode to stamp.
 * An earlier shape stamped `productId: row.productId` — a uuid — and relied on
 * its one caller to overwrite the field with the shortcode it happened to know.
 * That left a uuid-shaped `sourceMetadata` alive in the type system, one
 * forgetful second caller away from reaching the client, where the unit-mapping
 * table feeds that exact field into a Product detail lookup that is keyed on
 * the shortcode. Whoever owns the shortcode stamps it (see
 * `getProductSummaries`); nobody else can.
 */
export const getProductUnitMappingsByProductIds = async (
  // Accepts a transaction too: the bulk inventory-valuation paths load a
  // product's conversion graph mid-write, and must see their own uncommitted
  // mapping rows.
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Record<string, Array<Omit<UnitMapping, "sourceMetadata">>>> => {
  const uniqueIds = uniq([...ids]);
  const result: Record<
    string,
    Array<Omit<UnitMapping, "sourceMetadata">>
  > = Object.fromEntries(uniqueIds.map((id) => [id, []]));
  if (uniqueIds.length === 0) return result;

  const rows = await unwrapDb(db).query.productUnitMappings.findMany({
    where: and(
      inArray(productUnitMappings.productId, uniqueIds),
      notDeleted(productUnitMappings),
    ),
  });

  for (const row of rows) {
    result[row.productId]?.push({
      ...unitMappingSides(row),
      source: row.source,
    });
  }

  return result;
};
