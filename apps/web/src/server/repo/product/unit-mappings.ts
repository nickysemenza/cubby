/**
 * A product's stored conversion rows, read on their own.
 *
 * Lives outside `product/crud.ts` to keep the module graph acyclic: the
 * inventory valuation path (`repo/inventory/valuation.ts`) needs this read to
 * build a product's unit graph, `repo/inventory/crud.ts` imports that, and
 * `product/crud.ts` imports *back* into `inventory/crud.ts` to resync
 * valuations after a price or mapping edit. Leaving the read in `crud.ts`
 * closed that loop. `product/price-sync.ts` was extracted for the same reason
 * and is the precedent.
 */

import type { ProductId } from "@cubby/schemas/identifiers";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { and, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { productUnitMappings } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

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
      a: row.a,
      b: row.b,
      source: row.source,
    });
  }

  return result;
};
