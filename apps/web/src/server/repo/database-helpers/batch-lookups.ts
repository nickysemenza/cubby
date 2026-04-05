/**
 * Batch lookup helpers for CSV import optimization.
 * Reduces O(n) queries to O(1) by fetching all data upfront.
 */

import {
  type LocationId,
  type ProductId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ProductTopLevelOut } from "@cubby/schemas/product";

import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { and, ilike, inArray, or } from "drizzle-orm";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { dedupe } from "~/misc/array-helpers";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";
import { TraceNames, withTrace } from "~/server/tracing";

import { getDb } from "./core";
import { notDeleted } from "./query";
import { relations } from "./relations";
import { extractImagesFromJoinTable } from "./transform";

/**
 * Product lookup result with normalized keys for O(1) access.
 * Key format: "name|manufacturer" (lowercase, trimmed).
 */
export type ProductLookupMap = Map<string, ProductTopLevelOut>;

/**
 * Location lookup result indexed by both name and shortcode.
 * Keys: "name" (lowercase) or "shortcode:SHORTCODE" (uppercase).
 */
export type LocationLookupMap = Map<string, LocationId>;

/**
 * Inventory entry DB record with full relations.
 * Based on the actual query result from findMany with relations.inventory.full
 */
export type InventoryEntryDB = {
  id: string;
  productId: string;
  locationId: string;
  amount: { value: number; unit: string };
  valuation: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  Product: NonNullable<
    Awaited<ReturnType<typeof getDb>>["query"]["product"]["findFirst"]
  >;
  location: NonNullable<
    Awaited<ReturnType<typeof getDb>>["query"]["location"]["findFirst"]
  >;
};

/**
 * Inventory lookup result with normalized keys.
 * Key format: "productId|locationId".
 */
export type InventoryLookupMap = Map<string, InventoryEntryDB>;

/**
 * Normalize a product name + manufacturer pair into a lookup key.
 * Handles null manufacturer by converting to "(unspecified)".
 */
function makeProductKey(name: string, manufacturer: string | null): string {
  const normalizedName = name.toLowerCase().trim();
  const normalizedManufacturer = (
    manufacturer
      ? isUnspecifiedManufacturer(manufacturer)
        ? UNSPECIFIED_MANUFACTURER
        : manufacturer
      : UNSPECIFIED_MANUFACTURER
  )
    .toLowerCase()
    .trim();

  return `${normalizedName}|${normalizedManufacturer}`;
}

/**
 * Batch fetch products by names and manufacturers.
 * Returns map keyed by "name|manufacturer" (normalized, lowercase).
 *
 * Performance: 1 query regardless of input size (uses WHERE OR for each pair).
 */
export async function batchFindProductsByNameManufacturer(
  db: Database,
  lookups: Array<{ name: string; manufacturer: string | null }>,
): Promise<ProductLookupMap> {
  if (lookups.length === 0) return new Map();

  return withTrace(
    TraceNames.db("batchFindProductsByNameManufacturer"),
    async (span) => {
      span.setAttribute("db.batch_size", lookups.length);

      // Build WHERE clause with OR conditions for each (name, manufacturer) pair
      const conditions = lookups.map(({ name, manufacturer }) => {
        const normalizedManufacturer =
          manufacturer && !isUnspecifiedManufacturer(manufacturer)
            ? manufacturer
            : UNSPECIFIED_MANUFACTURER;

        return and(
          ilike(product.name, name),
          ilike(product.manufacturer, normalizedManufacturer),
        );
      });

      const products = await getDb(db).query.product.findMany({
        where: and(or(...conditions), notDeleted(product)),
        ...relations.product.full,
      });

      span.setAttribute("db.result_count", products.length);

      // Build lookup map with normalized keys
      const map = new Map<string, ProductTopLevelOut>();
      for (const p of products) {
        const key = makeProductKey(p.name, p.manufacturer);
        map.set(key, {
          id: unsafeProductId(p.id),
          shortcode: unsafeProductShortcode(p.shortcode),
          name: p.name,
          manufacturer: p.manufacturer,
          model: p.model,
          upc: p.upc,
          ndb_number: p.ndb_number,
          expectedQuantity: p.expectedQuantity,
          category: p.category,
          notes: p.notes,
          price: p.price,
          images: extractImagesFromJoinTable(p.images),
          externalIds: p.externalIds.filter((eid) => eid.deletedAt === null),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      }

      return map;
    },
  );
}

/**
 * Batch fetch locations by names and shortcodes.
 * Returns map indexed by:
 * - Normalized name (lowercase): "kitchen"
 * - Shortcode with prefix (uppercase): "shortcode:KTCHN"
 *
 * This allows flexible lookups by either name or shortcode.
 */
export async function batchFindLocations(
  db: Database,
  names: string[],
  shortcodes: string[],
): Promise<LocationLookupMap> {
  // Filter out empty strings and dedupe
  const cleanedNames = dedupe(
    names.filter((n) => n && n.trim() !== "").map((n) => n.trim()),
  );
  const cleanedShortcodes = dedupe(
    shortcodes
      .filter((s) => s && s.trim() !== "")
      .map((s) => s.trim().toUpperCase()),
  );

  if (cleanedNames.length === 0 && cleanedShortcodes.length === 0) {
    return new Map();
  }

  return withTrace(TraceNames.db("batchFindLocations"), async (span) => {
    span.setAttributes({
      "db.names_count": cleanedNames.length,
      "db.shortcodes_count": cleanedShortcodes.length,
    });

    const conditions = [];
    if (cleanedNames.length > 0) {
      conditions.push(inArray(location.name, cleanedNames));
    }
    if (cleanedShortcodes.length > 0) {
      conditions.push(inArray(location.shortcode, cleanedShortcodes));
    }

    const locations = await getDb(db).query.location.findMany({
      where: and(or(...conditions), notDeleted(location)),
      columns: { id: true, name: true, shortcode: true },
    });

    span.setAttribute("db.result_count", locations.length);

    const map = new Map<string, LocationId>();
    for (const loc of locations) {
      const locationId = unsafeLocationId(loc.id);

      // Index by normalized name
      map.set(loc.name.toLowerCase().trim(), locationId);

      // Index by shortcode (with prefix)
      if (loc.shortcode) {
        map.set(`shortcode:${loc.shortcode.toUpperCase()}`, locationId);
      }
    }

    return map;
  });
}

/**
 * Batch fetch existing inventory entries for given products and locations.
 * Returns map keyed by "productId|locationId".
 */
export async function batchFindInventoryEntries(
  db: Database,
  productIds: ProductId[],
  locationIds: LocationId[],
): Promise<InventoryLookupMap> {
  if (productIds.length === 0 || locationIds.length === 0) {
    return new Map();
  }

  return withTrace(TraceNames.db("batchFindInventoryEntries"), async (span) => {
    span.setAttributes({
      "db.products_count": productIds.length,
      "db.locations_count": locationIds.length,
    });

    const entries = await getDb(db).query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.productId, productIds as string[]),
        inArray(inventoryEntry.locationId, locationIds as string[]),
        notDeleted(inventoryEntry),
      ),
      ...relations.inventory.full,
    });

    span.setAttribute("db.result_count", entries.length);

    const map = new Map<string, InventoryEntryDB>();
    for (const entry of entries) {
      const key = `${entry.productId}|${entry.locationId}`;
      map.set(key, entry as unknown as InventoryEntryDB);
    }

    return map;
  });
}

/**
 * Batch fetch ingredients by names.
 * Returns map keyed by normalized name (lowercase).
 */
export async function batchFindIngredients(
  db: Database,
  names: string[],
): Promise<Map<string, string>> {
  const cleanedNames = dedupe(
    names.filter((n) => n && n.trim() !== "").map((n) => n.trim()),
  );

  if (cleanedNames.length === 0) {
    return new Map();
  }

  return withTrace(TraceNames.db("batchFindIngredients"), async (span) => {
    span.setAttribute("db.batch_size", cleanedNames.length);

    const ingredients = await getDb(db).query.ingredient.findMany({
      where: inArray(ingredient.name, cleanedNames),
      columns: { id: true, name: true },
    });

    span.setAttribute("db.result_count", ingredients.length);

    const map = new Map<string, string>();
    for (const ing of ingredients) {
      map.set(ing.name.toLowerCase().trim(), ing.id);
    }

    return map;
  });
}

/**
 * Batch fetch products by UPC codes.
 * Returns map keyed by UPC code.
 */
export async function batchFindProductsByUPC(
  db: Database,
  upcs: string[],
): Promise<Map<string, ProductTopLevelOut>> {
  const cleanedUpcs = dedupe(
    upcs.filter((upc) => upc && upc.trim() !== "").map((upc) => upc.trim()),
  );

  if (cleanedUpcs.length === 0) {
    return new Map();
  }

  return withTrace(TraceNames.db("batchFindProductsByUPC"), async (span) => {
    span.setAttribute("db.batch_size", cleanedUpcs.length);

    const products = await getDb(db).query.product.findMany({
      where: and(inArray(product.upc, cleanedUpcs), notDeleted(product)),
      ...relations.product.full,
    });

    span.setAttribute("db.result_count", products.length);

    const map = new Map<string, ProductTopLevelOut>();
    for (const p of products) {
      if (p.upc) {
        map.set(p.upc, {
          id: unsafeProductId(p.id),
          shortcode: unsafeProductShortcode(p.shortcode),
          name: p.name,
          manufacturer: p.manufacturer,
          model: p.model,
          upc: p.upc,
          ndb_number: p.ndb_number,
          expectedQuantity: p.expectedQuantity,
          category: p.category,
          notes: p.notes,
          price: null, // Price will be computed from unit mappings
          images: extractImagesFromJoinTable(p.images),
          externalIds: p.externalIds.filter((eid) => eid.deletedAt === null),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        });
      }
    }

    return map;
  });
}

/**
 * Batch fetch products by IDs.
 * Returns map keyed by product ID.
 */
export async function batchFindProductsByIds(
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, ProductTopLevelOut>> {
  if (ids.length === 0) {
    return new Map();
  }

  return withTrace(TraceNames.db("batchFindProductsByIds"), async (span) => {
    span.setAttribute("db.batch_size", ids.length);

    const products = await getDb(db).query.product.findMany({
      where: and(inArray(product.id, ids as string[]), notDeleted(product)),
      ...relations.product.full,
    });

    span.setAttribute("db.result_count", products.length);

    const map = new Map<ProductId, ProductTopLevelOut>();
    for (const p of products) {
      map.set(unsafeProductId(p.id), {
        id: unsafeProductId(p.id),
        shortcode: unsafeProductShortcode(p.shortcode),
        name: p.name,
        manufacturer: p.manufacturer,
        model: p.model,
        upc: p.upc,
        ndb_number: p.ndb_number,
        expectedQuantity: p.expectedQuantity,
        category: p.category,
        notes: p.notes,
        price: null, // Price will be computed from unit mappings
        images: extractImagesFromJoinTable(p.images),
        externalIds: p.externalIds.filter((eid) => eid.deletedAt === null),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
    }

    return map;
  });
}

/**
 * Helper to create product lookup key for testing/debugging.
 * @internal
 */
export function createProductKey(
  name: string,
  manufacturer: string | null,
): string {
  return makeProductKey(name, manufacturer);
}
