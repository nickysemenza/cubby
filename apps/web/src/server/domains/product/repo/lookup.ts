import {
  GTIN_KIND,
  GTIN_SOURCE,
  normalizeGtin,
} from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { RawProductListInventoryEntryOut } from "@cubby/schemas/product-raw-read";
import {
  type RawProductOutput,
  rawProductOutput,
} from "@cubby/schemas/product-raw-read";
import { type FoodLookupParam, foodLookupParam } from "@cubby/usda";
import { and, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { match } from "ts-pattern";

import type { Database } from "~/server/db";
import { escapeLike, getDb, notDeleted } from "~/server/db/helpers";
import {
  entityExternalId,
  inventoryEntry,
  product,
  vendor,
} from "~/server/db/schema";
import {
  attachInventoryValuations,
  loadStoredInventoryValuations,
} from "~/server/domains/inventory/repo/valuation";
import {
  loadPrimaryGtins,
  productHasGtin,
} from "~/server/domains/product/repo/gtin";
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import {
  GENERIC_BRAND_SYSTEM_KEY,
  parseBrandClaim,
  vendorNamedSql,
} from "~/server/domains/vendor/repo/product-brand";

import { productScaffold } from "./crud";
import { mapProductListInventoryEntries } from "./mappers";

const productMatchesFoodLookup = (
  linkedProduct: {
    fdc_id: number | null;
    externalIds: ReadonlyArray<{
      source: string;
      kind: string;
      externalId: string;
    }>;
  },
  lookup: FoodLookupParam,
): boolean =>
  match(lookup)
    .with({ kind: "fdc" }, ({ fdc_id }) => linkedProduct.fdc_id === fdc_id)
    .with({ kind: "ndb" }, () => false)
    .with({ kind: "upc" }, ({ gtin_upc }) => {
      const normalized = normalizeGtin(gtin_upc);
      return (
        normalized !== null &&
        linkedProduct.externalIds.some(
          (externalId) =>
            externalId.source === GTIN_SOURCE &&
            externalId.kind === GTIN_KIND &&
            externalId.externalId === normalized,
        )
      );
    })
    .exhaustive();

const productFoodLinkCondition = (lookups: readonly FoodLookupParam[]) =>
  or(
    ...lookups.map((lookup) =>
      match(lookup)
        .with({ kind: "upc" }, (value) => productHasGtin(value.gtin_upc))
        .with({ kind: "fdc" }, (value) => eq(product.fdc_id, value.fdc_id))
        .with({ kind: "ndb" }, () => sql`false`)
        .exhaustive(),
    ),
  );

/** Live Product records by internal id, in id order, through the declared read. */
const readProductRecords = async (
  db: Database,
  ids: readonly ProductId[],
): Promise<RawProductOutput[]> =>
  (await productScaffold.getByIds(db, ids)).data.map((row) =>
    rawProductOutput.parse(row),
  );

/**
 * Resolve every USDA identifier with one product projection.
 *
 * Pricing and data-quality enrichment are themselves batch reads, so the query
 * count is bounded by the projection depth rather than the USDA page size.
 * Results preserve input order (including duplicates) for direct correlation
 * by service callers.
 */
export const findProductsByFoodIdentifiers = async (
  db: Database,
  rawLookups: readonly FoodLookupParam[],
): Promise<RawProductOutput[][]> => {
  if (rawLookups.length === 0) {
    return [];
  }

  const lookups = rawLookups.map((lookup) => foodLookupParam.parse(lookup));

  // Find all matching products (exclude soft-deleted). A product links to a food
  // by its explicit fdc_id or by any of its barcodes. Products no longer store
  // an NDB number, so an NDB-keyed lookup (still a valid way to identify a USDA
  // food) matches nothing on the product side.
  //
  // `productHasGtin` normalizes, which is a recall FIX as well as a port: USDA
  // hands us a 12-digit `gtin_upc`, and a product holding the 13- or 14-digit
  // form of that same barcode never matched the old `eq(product.upc, ...)`.
  const linkCondition = productFoodLinkCondition(lookups);

  const ids = await getDb(db)
    .select({ id: product.id })
    .from(product)
    .where(and(linkCondition, notDeleted(product)));
  const linkedProducts = await readProductRecords(
    db,
    ids.map((row) => row.id),
  );
  return lookups.map((lookup) =>
    linkedProducts.filter((linkedProduct) =>
      productMatchesFoodLookup(linkedProduct, lookup),
    ),
  );
};

/**
 * Count live product links for USDA foods without loading images, pricing, or
 * data-quality. List sorting needs only this association; the selected page is
 * enriched by {@link findProductsByFoodIdentifiers} afterwards.
 */
export const countProductsByFoodIdentifiers = async (
  db: Database,
  rawLookups: readonly FoodLookupParam[],
): Promise<number[]> => {
  if (rawLookups.length === 0) return [];

  const lookups = rawLookups.map((lookup) => foodLookupParam.parse(lookup));
  const linkCondition = productFoodLinkCondition(lookups);
  const products = await getDb(db).query.product.findMany({
    where: and(linkCondition, notDeleted(product)),
    columns: { fdc_id: true },
    with: { externalIds: { where: notDeleted(entityExternalId) } },
  });
  return lookups.map(
    (lookup) =>
      products.filter((linkedProduct) =>
        productMatchesFoodLookup(linkedProduct, lookup),
      ).length,
  );
};

export const findProductsByFoodIdentifier = async (
  db: Database,
  rawLookup?: FoodLookupParam,
): Promise<RawProductOutput[]> => {
  if (!rawLookup) return [];
  return (await findProductsByFoodIdentifiers(db, [rawLookup]))[0] ?? [];
};

export const getFoodLookupsForLinkedProducts = async (
  db: Database,
): Promise<FoodLookupParam[]> => {
  const rows = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: { id: true, fdc_id: true },
  });
  const gtins = await loadPrimaryGtins(
    db,
    rows.filter((row) => row.fdc_id == null).map((row) => row.id),
  );

  return rows.flatMap((row): FoodLookupParam[] => {
    const param = foodLookupParamFromProduct({
      fdc_id: row.fdc_id,
      primaryGtin: gtins.get(row.id) ?? null,
    });
    return param ? [param] : [];
  });
};

/**
 * Run a single-product lookup and transform it to the API shape.
 * Shared by all the findProductBy* functions below: the only thing that varies
 * between them is the `where` condition.
 */
const findProductToAPI = async (
  db: Database,
  where: SQL | undefined,
): Promise<RawProductOutput | null> => {
  const found = await getDb(db)
    .select({ id: product.id })
    .from(product)
    .where(where)
    .limit(1);
  return (
    (
      await readProductRecords(
        db,
        found.map((row) => row.id),
      )
    )[0] ?? null
  );
};

/**
 * The product carrying this barcode, in ANY encoding (excludes soft-deleted).
 *
 * A 12-digit scan finds the product stored as the 13-digit reprint, because
 * both sides go through GTIN-14. Returning a single product stays honest
 * because `ProductExternalId_source_kind_externalId_key` guarantees one live
 * owner per barcode — the same guarantee `Product_upc_key` gave, minus the
 * length-sensitivity that let one item exist twice under two encodings.
 */
export const findProductByGtin = (
  db: Database,
  barcode: string,
): Promise<RawProductOutput | null> =>
  findProductToAPI(db, and(productHasGtin(barcode), notDeleted(product)));

/** External text can retrieve a candidate, but duplicate names never establish Brand identity. */
export const findProductByNameWithBrandClaim = async (
  db: Database,
  name: string,
  brandClaim: string | null | undefined,
): Promise<RawProductOutput | null> => {
  const claim = parseBrandClaim(brandClaim);
  let brandId: import("@cubby/schemas/identifiers").VendorId | undefined;
  if (claim) {
    const brands = await getDb(db)
      .select({ id: vendor.id })
      .from(vendor)
      .where(
        and(
          notDeleted(vendor),
          claim.generic
            ? eq(vendor.systemKey, GENERIC_BRAND_SYSTEM_KEY)
            : vendorNamedSql(claim.name),
        ),
      )
      .limit(2);
    if (brands.length !== 1) return null;
    brandId = brands[0]!.id;
  }
  const matches = await getDb(db)
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        notDeleted(product),
        ilike(product.name, escapeLike(name)),
        brandId ? eq(product.brandId, brandId) : undefined,
      ),
    )
    .limit(2);
  return matches.length === 1
    ? findProductToAPI(db, eq(product.id, matches[0]!.id))
    : null;
};

/**
 * Live stock entries, with their locations, for a bounded set of products.
 *
 * One grouped read for the whole batch — the same shape as `taskSubtaskCounts`
 * and `taskDependencyIds`, and for the same reason: the callers are table pages
 * resolving a product reference per row, so a per-row read would be N+1.
 * `InventoryEntry_productId_idx` covers the lookup.
 *
 * Rows are mapped through `mapProductListInventoryEntries`, so soft-deleted
 * locations drop out here exactly as they do on the product list.
 */
export const loadProductInventoryEntries = async (
  db: Database,
  ids: readonly ProductId[],
): Promise<Map<ProductId, RawProductListInventoryEntryOut[]>> => {
  const out = new Map<ProductId, RawProductListInventoryEntryOut[]>();
  if (ids.length === 0) return out;

  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, [...ids]),
      notDeleted(inventoryEntry),
    ),
    orderBy: inventoryEntry.createdAt,
    with: { location: true },
  });
  const valuations = await loadStoredInventoryValuations(
    db,
    rows.map((row) => row.id),
  );

  const byProduct = new Map<ProductId, typeof rows>();
  for (const row of rows) {
    const bucket = byProduct.get(row.productId);
    if (bucket) bucket.push(row);
    else byProduct.set(row.productId, [row]);
  }
  for (const [productId, entries] of byProduct) {
    out.set(
      productId,
      mapProductListInventoryEntries(
        attachInventoryValuations(entries, valuations),
      ),
    );
  }
  return out;
};

/** Every live Product with an explicit USDA link, for advancing superseded revisions. */
export async function listProductFdcLinks(
  db: Database,
): Promise<Array<{ id: ProductId; fdcId: number }>> {
  const rows = await getDb(db)
    .select({ id: product.id, fdcId: product.fdc_id })
    .from(product)
    .where(and(sql`${product.fdc_id} IS NOT NULL`, notDeleted(product)));
  return rows.flatMap((row) =>
    row.fdcId === null ? [] : [{ id: row.id, fdcId: row.fdcId }],
  );
}
