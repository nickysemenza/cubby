/**
 * Product analytics operations.
 * Category distribution, duplicate detection, and backfill operations.
 */

import type {
  LocationId,
  LocationShortcode,
  ProductId,
} from "@cubby/schemas/identifiers";
import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import type { LocationAncestorOut } from "@cubby/schemas/location";
import type { ProductCategory } from "@cubby/schemas/product";
import { isCollectionTag } from "@cubby/shared/collection-tag";
import {
  and,
  arrayOverlaps,
  eq,
  isNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  image,
  inventoryEntry,
  location,
  product,
  productExternalId,
  productImage,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { stockOnly } from "~/server/repo/inventory/placement";
// Deep import, not the `~/server/repo/location` barrel: that barrel pulls in
// `location/crud`, which imports `product/pricing` — a product module going
// through it would close an import cycle. `location/tree` imports no product
// code.
import { loadLocationAncestors } from "~/server/repo/location/tree";
import { loadPrimaryGtins, productHasAnyGtin } from "./gtin";

export const findDuplicateUniqueProducts = async (
  db: Database,
  { excludeLocationId }: { excludeLocationId?: LocationId } = {},
) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: and(eq(product.expectedQuantity, 1), notDeleted(product)),
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        with: {
          location: true,
        },
      },
    },
  });

  return duplicates.filter((prod) => {
    if (prod.inventoryEntry.length <= 1) return false;
    // Skip duplicates that involve the excluded location entirely.
    if (
      excludeLocationId &&
      prod.inventoryEntry.some(
        (entry) => entry.location.id === excludeLocationId,
      )
    ) {
      return false;
    }
    return true;
  });
};

export const findProductsWithNoImages = async (
  db: Database,
  { excludeIngredients = false } = {},
): Promise<
  Array<{
    id: ProductId;
    shortcode: string;
    name: string;
    manufacturer: string;
    primaryGtin: string | null;
  }>
> => {
  const dbClient = getDb(db);

  const conditions = [notDeleted(product)];
  if (excludeIngredients) {
    conditions.push(isNull(product.ingredientId));
  }

  // PDF manuals live in the same Image table/join — count only displayable
  // (non-PDF) attachments so a manual-only product still reads as "no images".
  const results = await dbClient
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
    })
    .from(product)
    .leftJoin(
      productImage,
      and(eq(productImage.productId, product.id), notDeleted(productImage)),
    )
    .leftJoin(
      image,
      and(eq(image.id, productImage.imageId), displayableImageWhere),
    )
    .where(and(...conditions))
    .groupBy(product.id)
    .having(sql`count(${image.id}) = 0`);

  // The barcode is what the image backfill looks the product up BY, so it is
  // carried on the row rather than re-fetched per candidate downstream.
  const gtins = await loadPrimaryGtins(
    db,
    results.map((row) => row.id),
  );
  return results.map((row) => ({
    ...row,
    primaryGtin: gtins.get(row.id) ?? null,
  }));
};

/**
 * Scalar counterpart of the Maintenance card's barcode-backed image backfill
 * candidate list. The action still loads presenter rows through
 * {@link findProductsWithNoImages}; its always-on count must not ship each
 * product and GTIN across the connection merely to return a number.
 */
export const countProductsWithNoImagesWithGtin = async (
  db: Database,
): Promise<number> => {
  const dbClient = getDb(db);
  const [row] = await dbClient
    .select({ count: sql<number>`count(*)::int` })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNull(product.ingredientId),
        productHasAnyGtin(),
        notExists(
          dbClient
            .select({ one: sql`1` })
            .from(productImage)
            .innerJoin(image, eq(image.id, productImage.imageId))
            .where(
              and(
                eq(productImage.productId, product.id),
                notDeleted(productImage),
                displayableImageWhere,
              ),
            ),
        ),
      ),
    );
  return row?.count ?? 0;
};

/**
 * The distinct tag roster with usage counts, ranked by frequency then
 * alphabetically — feeds the product list's Tags filter picklist.
 *
 * Grouped SQL over `unnest`, not recipe/queries.ts's `getAllTags`, which loads
 * every row's tags and de-dupes into a Set in JS. Same "cheap options query"
 * shape as `vendorOptions` (repo/vendor.ts).
 */
export const getProductTagOptions = async (
  db: Database,
): Promise<Array<{ tag: string; count: number }>> => {
  const rows = await getDb(db)
    .select({
      tag: sql<string>`tag`,
      count: sql<number>`count(*)::int`,
    })
    .from(sql`${product}, unnest(${product.tags}) AS tag`)
    .where(and(notDeleted(product), sql`tag NOT LIKE 'collection:%'`))
    .groupBy(sql`tag`)
    .orderBy(sql`count(*) DESC, tag ASC`);

  return rows;
};

/**
 * The distinct external-ID source roster with product counts — feeds the
 * product list's External IDs filter picklist.
 *
 * A source is an open kebab-case slug minted by whichever importer wrote the
 * row (`amazon`, `home-depot`, `mcmaster`), so there is no enum to render a
 * static option list from; the roster has to come from the data. Counted over
 * DISTINCT products because one product can carry several ids from one source
 * (different `kind`s), and the filter narrows PRODUCTS.
 */
export const getProductExternalIdSourceOptions = async (
  db: Database,
): Promise<Array<{ source: string; count: number }>> =>
  getDb(db)
    .select({
      source: productExternalId.source,
      count: sql<number>`count(distinct ${productExternalId.productId})::int`,
    })
    .from(productExternalId)
    .innerJoin(product, eq(product.id, productExternalId.productId))
    .where(and(notDeleted(productExternalId), notDeleted(product)))
    .groupBy(productExternalId.source)
    .orderBy(
      sql`count(distinct ${productExternalId.productId}) DESC`,
      productExternalId.source,
    );

/** Distinct server-backed manufacturer roster for exact list filtering. */
export const getProductManufacturerOptions = async (
  db: Database,
): Promise<Array<{ manufacturer: string; count: number }>> =>
  getDb(db)
    .select({
      manufacturer: product.manufacturer,
      count: sql<number>`count(*)::int`,
    })
    .from(product)
    .where(notDeleted(product))
    .groupBy(product.manufacturer)
    .orderBy(sql`count(*) DESC`, product.manufacturer);

/**
 * Every other product sharing at least one tag with `id` — the "fits with this"
 * roster on the product detail page.
 *
 * Returns each sibling's full `tags` so the caller can group by the shared tag
 * without a second round trip. Intersecting in the component rather than
 * pivoting in SQL keeps this a single flat query.
 *
 * Ecosystem tags ARE tiny (`M18` is 6 products), but provenance tags are not —
 * `home-depot-import` is 536 and `amazon` 324, so this is a few hundred scalar
 * rows on the widest tag, not the handful an ecosystem tag suggests. Still one
 * indexed scan and no pivot; sizing decisions here should use the provenance
 * numbers rather than the ecosystem ones.
 *
 * Empty tags short-circuits: `arrayOverlaps` against `'{}'` matches nothing, so
 * the query would be a guaranteed-empty scan.
 */
export const getProductsSharingTags = async (
  db: Database,
  id: ProductId,
): Promise<
  Array<{
    id: ProductId;
    shortcode: string;
    name: string;
    manufacturer: string;
    category: ProductCategory | null;
    tags: string[];
  }>
> => {
  const source = await getDb(db)
    .select({ tags: product.tags })
    .from(product)
    .where(and(eq(product.id, id), notDeleted(product)))
    .limit(1);

  const tags = (source[0]?.tags ?? []).filter((tag) => !isCollectionTag(tag));
  if (tags.length === 0) return [];

  return await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
      tags: product.tags,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        ne(product.id, id),
        arrayOverlaps(product.tags, tags),
      ),
    )
    .orderBy(product.name);
};

/** Locations shown per tag before the list is truncated. */
const TAG_STORAGE_LOCATION_LIMIT = 4;

export interface TagSiblingStorage {
  tag: string;
  locations: Array<{
    id: LocationShortcode;
    name: string;
    /** Root → immediate parent. Empty for a top-level location. */
    ancestors: LocationAncestorOut[];
    /** Distinct sibling products stocked here — never counts `id` itself. */
    productCount: number;
    /** `id` is stocked here too, so the family already has this product. */
    holdsSource: boolean;
  }>;
  /** Locations past {@link TAG_STORAGE_LOCATION_LIMIT}, for disclosure. */
  omittedLocationCount: number;
}

/**
 * Where each of `id`'s tags is stored — the put-away half of "Fits With".
 *
 * The roster (`getProductsSharingTags`) answers what else is in an ecosystem;
 * this answers where that ecosystem lives, so a new M18 battery in hand can be
 * put where the rest of the M18 kit already sits without opening four siblings.
 *
 * ## Counting
 *
 * A location's count is **distinct sibling products** — "3 M18 things live
 * here" is the signal, not how many rows record them. Today the two coincide,
 * because the partial unique index on
 * `(productId, locationId, placement) WHERE deletedAt IS NULL` already permits
 * only one live stock row per pair; counting products keeps the number meaning
 * what the panel says it means if that ever loosens.
 *
 * The source product is deliberately part of the query but never part of a
 * count. Its rows only raise `holdsSource`, which is what lets the panel
 * distinguish "the family lives here, and so do you" from "the family lives
 * here, you don't" — the whole point of showing this next to the roster. One
 * query covers both signals.
 *
 * ## Truncation
 *
 * Capped here rather than in JSX because a renderer-intrinsic omission has to
 * be server-enforced and disclosed; `omittedLocationCount` is that disclosure.
 *
 * Pivoting per tag in TS rather than `unnest`-ing tags in SQL matches
 * `getProductsSharingTags` and keeps `notDeleted` / `stockOnly` as ordinary
 * helpers — a hand-rolled `t.tag = ANY(${tags})` would be the row-constructor
 * trap.
 *
 * There is no SQL `LIMIT`: the cap is per tag, and which locations survive it
 * is only known after the fold. What bounds the scan is that this reads
 * INVENTORY, not products — a tag's stocked entries, not its membership. The
 * widest tags are provenance ones, and they are the sparsely-stocked ones:
 * `home-depot-import` spans 536 products but only ~49 stocked entries,
 * `amazon` 324 for ~106. A tag that is both very popular AND densely stocked
 * would break that, and is the case to re-measure before assuming this holds.
 */
export const getTagSiblingStorage = async (
  db: Database,
  id: ProductId,
): Promise<TagSiblingStorage[]> => {
  const source = await getDb(db)
    .select({ tags: product.tags })
    .from(product)
    .where(and(eq(product.id, id), notDeleted(product)))
    .limit(1);

  const tags = (source[0]?.tags ?? []).filter((tag) => !isCollectionTag(tag));
  if (tags.length === 0) return [];

  // One row per (product, entry) for every product sharing a tag, the source
  // included. `stockOnly()` because this is a countable browse surface — a
  // fixture wired into a wall is not somewhere to put a spare battery.
  const rows = await getDb(db)
    .select({
      productId: product.id,
      productTags: product.tags,
      locationId: location.id,
      locationShortcode: location.shortcode,
      locationName: location.name,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(product.id, inventoryEntry.productId))
    .innerJoin(location, eq(location.id, inventoryEntry.locationId))
    .where(
      and(
        notDeleted(inventoryEntry),
        stockOnly(),
        notDeleted(product),
        notDeleted(location),
        arrayOverlaps(product.tags, tags),
      ),
    );

  interface Tally {
    locationId: LocationId;
    shortcode: string;
    name: string;
    productIds: Set<ProductId>;
    holdsSource: boolean;
  }
  const byTag = new Map<string, Map<LocationId, Tally>>();
  const sourceTags = new Set(tags);

  for (const row of rows) {
    for (const tag of row.productTags) {
      // A sibling carries its own unrelated tags too; only the viewed
      // product's tags are groups the panel will ever render.
      if (!sourceTags.has(tag)) continue;

      let locations = byTag.get(tag);
      if (!locations) {
        locations = new Map();
        byTag.set(tag, locations);
      }

      let tally = locations.get(row.locationId);
      if (!tally) {
        tally = {
          locationId: row.locationId,
          shortcode: row.locationShortcode,
          name: row.locationName,
          productIds: new Set(),
          holdsSource: false,
        };
        locations.set(row.locationId, tally);
      }

      // The Set is what makes the count distinct-by-product across entries.
      if (row.productId === id) tally.holdsSource = true;
      else tally.productIds.add(row.productId);
    }
  }

  const ranked = tags.flatMap((tag) => {
    const tallies = [...(byTag.get(tag)?.values() ?? [])]
      // A location holding only the source product tells you nothing about
      // where the family lives — that is just this product's own Stocked At.
      .filter((t) => t.productIds.size > 0)
      .sort(
        (a, b) =>
          b.productIds.size - a.productIds.size || a.name.localeCompare(b.name),
      );
    if (tallies.length === 0) return [];
    return [
      {
        tag,
        tallies: tallies.slice(0, TAG_STORAGE_LOCATION_LIMIT),
        omittedLocationCount: Math.max(
          0,
          tallies.length - TAG_STORAGE_LOCATION_LIMIT,
        ),
      },
    ];
  });

  // One batched CTE for every surviving location across all tags.
  const ancestorsById = await loadLocationAncestors(db, [
    ...new Set(ranked.flatMap((g) => g.tallies.map((t) => t.locationId))),
  ]);

  return ranked.map(({ tag, tallies, omittedLocationCount }) => ({
    tag,
    omittedLocationCount,
    locations: tallies.map((t) => ({
      id: unsafeLocationShortcode(t.shortcode),
      name: t.name,
      ancestors: ancestorsById.get(t.locationId) ?? [],
      productCount: t.productIds.size,
      holdsSource: t.holdsSource,
    })),
  }));
};

export const getCategoryDistribution = async (
  db: Database,
): Promise<
  Array<{
    category: ProductCategory | null;
    productCount: number;
    locations: Array<{ id: string; name: string; count: number }>;
  }>
> => {
  const dbClient = getDb(db);

  const productsWithInventory = await dbClient.query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      category: true,
    },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        columns: {},
        with: {
          location: {
            columns: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  const categoryMap = new Map<
    ProductCategory | null,
    {
      productCount: number;
      locationCounts: Map<string, { id: string; name: string; count: number }>;
    }
  >();

  for (const prod of productsWithInventory) {
    const cat = prod.category as ProductCategory | null;

    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, {
        productCount: 0,
        locationCounts: new Map(),
      });
    }

    const catData = categoryMap.get(cat)!;
    catData.productCount++;

    for (const entry of prod.inventoryEntry) {
      const loc = entry.location;
      const existing = catData.locationCounts.get(loc.id);
      if (existing) {
        existing.count++;
      } else {
        catData.locationCounts.set(loc.id, {
          id: loc.id,
          name: loc.name,
          count: 1,
        });
      }
    }
  }

  const result: Array<{
    category: ProductCategory | null;
    productCount: number;
    locations: Array<{ id: string; name: string; count: number }>;
  }> = [];

  for (const [category, data] of categoryMap) {
    const locations = Array.from(data.locationCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    result.push({
      category,
      productCount: data.productCount,
      locations,
    });
  }

  result.sort((a, b) => b.productCount - a.productCount);

  return result;
};

/**
 * Get a lightweight product summary for AI category audit.
 * Returns name, manufacturer, and category for all non-deleted products.
 */
export const getProductSummaryForAudit = async (
  db: Database,
): Promise<
  Array<{ name: string; manufacturer: string; category: string | null }>
> => {
  return getDb(db)
    .select({
      name: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
    })
    .from(product)
    .where(notDeleted(product));
};
