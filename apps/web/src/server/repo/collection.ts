import type {
  CollectionCellState,
  CollectionDetailOut,
  CollectionMatrixMembership,
  CollectionMatrixOut,
  CollectionMatrixSort,
  CollectionProductPlacementOut,
  CollectionProductPurchaseOut,
  CollectionSlug,
  CollectionSummaryOut,
  CollectionTagSetInput,
} from "@cubby/schemas/collection";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type LocationId,
  type ProductId,
  unsafeLocationShortcode,
  unsafeProductShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type { Trade } from "@cubby/schemas/project";
import { setCollectionTag } from "@cubby/shared/collection-tag";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  expense,
  inventoryEntry,
  location,
  product,
  purchase,
  purchaseProduct,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  getLocationCoverImageUrlsByLocationIds,
  updateLocation,
} from "~/server/repo/location";
import {
  getProductCoverImageUrlsByProductIds,
  updateProduct,
} from "~/server/repo/product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  deriveCollectionMembership,
  directCollectionMembership,
} from "./collection-membership";

interface GraphLocation {
  id: LocationId;
  shortcode: string;
  name: string;
  parentId: string | null;
  productId: string | null;
  tags: string[];
}

interface GraphProduct {
  id: ProductId;
  shortcode: string;
  name: string;
  manufacturer: string;
  tags: string[];
}

interface CollectionGraph {
  products: GraphProduct[];
  locations: GraphLocation[];
  inventory: Array<{ productId: string; locationId: string }>;
  collections: CollectionSlug[];
  locationsById: Map<string, GraphLocation>;
  productInherited: Map<string, Set<CollectionSlug>>;
  locationInherited: Map<string, Set<CollectionSlug>>;
}

const locationPath = (
  loc: GraphLocation,
  locationsById: ReadonlyMap<string, GraphLocation>,
): string[] => {
  const names: string[] = [loc.name];
  const seen = new Set<string>([loc.id]);
  let parentId = loc.parentId;
  while (parentId && !seen.has(parentId) && names.length < 12) {
    seen.add(parentId);
    const parent = locationsById.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names;
};

const placementsByProductId = (
  graph: CollectionGraph,
): Map<string, CollectionProductPlacementOut[]> => {
  const locations = new Map<string, Map<string, GraphLocation>>();
  const add = (productId: string, loc: GraphLocation) => {
    const productLocations = locations.get(productId) ?? new Map();
    productLocations.set(loc.id, loc);
    locations.set(productId, productLocations);
  };
  for (const entry of graph.inventory) {
    const loc = graph.locationsById.get(entry.locationId);
    if (loc) add(entry.productId, loc);
  }
  for (const loc of graph.locations) {
    if (loc.productId) add(loc.productId, loc);
  }
  return new Map(
    [...locations].map(([productId, productLocations]) => [
      productId,
      [...productLocations.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((loc) => ({
          id: unsafeLocationShortcode(loc.shortcode),
          name: loc.name,
          path: locationPath(loc, graph.locationsById),
        })),
    ]),
  );
};

const loadPurchasesByProductId = async (
  db: Database,
  productIds: ProductId[],
): Promise<Map<string, CollectionProductPurchaseOut[]>> => {
  if (productIds.length === 0) return new Map();
  const client = getDb(db);
  const purchaseColumns = {
    purchaseId: purchase.id,
    purchaseCode: purchase.shortcode,
    orderId: purchase.orderId,
    displayLabel: purchase.displayLabel,
    date: purchase.date,
    vendorName: vendor.name,
  };
  const liveVendor = and(eq(vendor.id, purchase.vendorId), notDeleted(vendor));
  const [itemizedRows, linkedRows] = await Promise.all([
    client
      .selectDistinct({ productId: expense.productId, ...purchaseColumns })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        and(
          notDeleted(expense),
          eq(expense.future, false),
          inArray(expense.productId, productIds),
        ),
      ),
    client
      .select({ productId: purchaseProduct.productId, ...purchaseColumns })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        and(
          notDeleted(purchaseProduct),
          inArray(purchaseProduct.productId, productIds),
        ),
      ),
  ]);
  const purchaseIds = [
    ...new Set([...itemizedRows, ...linkedRows].map((row) => row.purchaseId)),
  ];
  const tradeRows =
    purchaseIds.length === 0
      ? []
      : await client
          .select({ purchaseId: expense.purchaseId, trade: expense.trade })
          .from(expense)
          .where(
            and(
              notDeleted(expense),
              eq(expense.future, false),
              inArray(expense.purchaseId, purchaseIds),
            ),
          );
  const tradesByPurchaseId = new Map<string, Set<Trade>>();
  for (const row of tradeRows) {
    if (!row.purchaseId) continue;
    const trades = tradesByPurchaseId.get(row.purchaseId) ?? new Set<Trade>();
    trades.add(row.trade);
    tradesByPurchaseId.set(row.purchaseId, trades);
  }
  const byProductId = new Map<
    string,
    Map<string, CollectionProductPurchaseOut>
  >();
  for (const row of [...itemizedRows, ...linkedRows]) {
    if (!row.productId) continue;
    const purchases = byProductId.get(row.productId) ?? new Map();
    purchases.set(row.purchaseId, {
      id: unsafePurchaseShortcode(row.purchaseCode),
      orderId: row.orderId,
      displayLabel: row.displayLabel,
      date: row.date,
      vendorName: row.vendorName,
      trades: [...(tradesByPurchaseId.get(row.purchaseId) ?? [])].sort(),
    });
    byProductId.set(row.productId, purchases);
  }
  return new Map(
    [...byProductId].map(([productId, purchases]) => [
      productId,
      [...purchases.values()].sort(
        (left, right) =>
          right.date.localeCompare(left.date) ||
          left.id.localeCompare(right.id),
      ),
    ]),
  );
};

const loadCollectionGraph = async (db: Database): Promise<CollectionGraph> => {
  const client = getDb(db);
  const [products, locations, inventory] = await Promise.all([
    client
      .select({
        id: product.id,
        shortcode: product.shortcode,
        name: product.name,
        manufacturer: product.manufacturer,
        tags: product.tags,
      })
      .from(product)
      .where(notDeleted(product))
      .orderBy(asc(product.name)),
    client
      .select({
        id: location.id,
        shortcode: location.shortcode,
        name: location.name,
        parentId: location.parentId,
        productId: location.productId,
        tags: location.tags,
      })
      .from(location)
      .where(notDeleted(location))
      .orderBy(asc(location.name)),
    client
      .select({
        productId: inventoryEntry.productId,
        locationId: inventoryEntry.locationId,
      })
      .from(inventoryEntry)
      .innerJoin(product, eq(product.id, inventoryEntry.productId))
      .innerJoin(location, eq(location.id, inventoryEntry.locationId))
      .where(
        and(
          notDeleted(inventoryEntry),
          notDeleted(product),
          notDeleted(location),
        ),
      ),
  ]);

  const locationsById = new Map<string, GraphLocation>(
    locations.map((loc) => [loc.id, loc]),
  );
  const { collections, productInherited, locationInherited } =
    deriveCollectionMembership({ products, locations, inventory });

  return {
    products,
    locations,
    inventory,
    collections,
    locationsById,
    productInherited,
    locationInherited,
  };
};

const summarizeCollection = (
  graph: CollectionGraph,
  slug: CollectionSlug,
): CollectionSummaryOut => ({
  slug,
  productCount: graph.products.filter(
    (item) =>
      directCollectionMembership(item.tags).has(slug) ||
      graph.productInherited.get(item.id)?.has(slug),
  ).length,
  rootLocationCount: graph.locations.filter((item) =>
    directCollectionMembership(item.tags).has(slug),
  ).length,
});

export const listCollections = async (
  db: Database,
): Promise<CollectionSummaryOut[]> => {
  const graph = await loadCollectionGraph(db);
  return graph.collections.map((slug) => summarizeCollection(graph, slug));
};

export const getCollectionDetail = async (
  db: Database,
  slug: CollectionSlug,
  search: string | undefined,
  pagination: { pageIndex: number; pageSize: number },
): Promise<CollectionDetailOut | null> => {
  const graph = await loadCollectionGraph(db);
  if (!graph.collections.includes(slug)) return null;
  const normalizedSearch = search?.toLocaleLowerCase();
  const matchingProducts = graph.products.filter((item) => {
    const member =
      directCollectionMembership(item.tags).has(slug) ||
      graph.productInherited.get(item.id)?.has(slug);
    return (
      member &&
      (!normalizedSearch ||
        item.name.toLocaleLowerCase().includes(normalizedSearch) ||
        item.manufacturer.toLocaleLowerCase().includes(normalizedSearch))
    );
  });
  const start = pagination.pageIndex * pagination.pageSize;
  const roots = graph.locations.filter((item) =>
    directCollectionMembership(item.tags).has(slug),
  );
  const productPage = matchingProducts.slice(
    start,
    start + pagination.pageSize,
  );
  const placements = placementsByProductId(graph);
  const [rootCoverImageUrls, productCoverImageUrls, purchases] =
    await Promise.all([
      getLocationCoverImageUrlsByLocationIds(
        db,
        roots.map((item) => item.id),
      ),
      getProductCoverImageUrlsByProductIds(
        db,
        productPage.map((item) => item.id),
      ),
      loadPurchasesByProductId(
        db,
        productPage.map((item) => item.id),
      ),
    ]);

  return {
    collection: summarizeCollection(graph, slug),
    roots: roots.map((item) => ({
      id: unsafeLocationShortcode(item.shortcode),
      name: item.name,
      path: locationPath(item, graph.locationsById),
      imageUrl: rootCoverImageUrls.get(item.id) ?? null,
    })),
    totalCount: matchingProducts.length,
    products: productPage.map((item) => ({
      id: unsafeProductShortcode(item.shortcode),
      name: item.name,
      manufacturer: item.manufacturer,
      imageUrl: productCoverImageUrls.get(item.id) ?? null,
      direct: directCollectionMembership(item.tags).has(slug),
      inherited: graph.productInherited.get(item.id)?.has(slug) ?? false,
      placements: placements.get(item.id) ?? [],
      purchases: purchases.get(item.id) ?? [],
    })),
  };
};

export const getCollectionMatrix = async (
  db: Database,
  subject: "product" | "location",
  search: string | undefined,
  sort: CollectionMatrixSort,
  selectedCollection: CollectionSlug | undefined,
  membership: CollectionMatrixMembership | undefined,
  pagination: { pageIndex: number; pageSize: number },
): Promise<CollectionMatrixOut> => {
  const graph = await loadCollectionGraph(db);
  const normalizedSearch = search?.toLocaleLowerCase();
  const secondaryFor = (item: GraphProduct | GraphLocation) =>
    subject === "product"
      ? (item as GraphProduct).manufacturer
      : locationPath(item as GraphLocation, graph.locationsById).join(" / ");
  const stateFor = (
    item: GraphProduct | GraphLocation,
    slug: CollectionSlug,
  ): CollectionCellState => {
    const direct = directCollectionMembership(item.tags).has(slug);
    const inherited =
      (subject === "product"
        ? graph.productInherited.get(item.id)
        : graph.locationInherited.get(item.id)
      )?.has(slug) ?? false;
    return direct
      ? inherited
        ? "both"
        : "direct"
      : inherited
        ? "inherited"
        : "empty";
  };
  const matchesMembership = (state: CollectionCellState) => {
    if (!membership) return true;
    if (membership === "member") return state !== "empty";
    if (membership === "direct") return state === "direct" || state === "both";
    if (membership === "inherited")
      return state === "inherited" || state === "both";
    return state === "empty";
  };
  const compareText = (left: string, right: string) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  const source = (subject === "product" ? graph.products : graph.locations)
    .filter((item) => {
      const secondary = secondaryFor(item);
      const matchesSearch =
        !normalizedSearch ||
        item.name.toLocaleLowerCase().includes(normalizedSearch) ||
        secondary.toLocaleLowerCase().includes(normalizedSearch);
      const state = selectedCollection
        ? stateFor(item, selectedCollection)
        : "empty";
      return matchesSearch && (!selectedCollection || matchesMembership(state));
    })
    .sort((left, right) => {
      const [leftValue, rightValue] = sort.startsWith("secondary")
        ? [secondaryFor(left), secondaryFor(right)]
        : [left.name, right.name];
      const compared = compareText(leftValue, rightValue);
      const directed = sort.endsWith("desc") ? -compared : compared;
      return directed || compareText(left.name, right.name);
    });
  const start = pagination.pageIndex * pagination.pageSize;
  const page = source.slice(start, start + pagination.pageSize);
  const productIds =
    subject === "product" ? page.map((item) => item.id as ProductId) : [];
  const [resolvedCoverImageUrls, purchases] = await Promise.all([
    subject === "product"
      ? getProductCoverImageUrlsByProductIds(db, productIds)
      : getLocationCoverImageUrlsByLocationIds(
          db,
          page.map((item) => item.id as LocationId),
        ),
    loadPurchasesByProductId(db, productIds),
  ]);
  const coverImageUrls: ReadonlyMap<string, string> = resolvedCoverImageUrls;
  const placements = placementsByProductId(graph);
  const rows = page.map((item) => {
    const direct = directCollectionMembership(item.tags);
    const inherited =
      subject === "product"
        ? graph.productInherited.get(item.id)
        : graph.locationInherited.get(item.id);
    return {
      id:
        subject === "product"
          ? unsafeProductShortcode(item.shortcode)
          : unsafeLocationShortcode(item.shortcode),
      name: item.name,
      secondary: secondaryFor(item),
      imageUrl: coverImageUrls.get(item.id) ?? null,
      placements: subject === "product" ? (placements.get(item.id) ?? []) : [],
      purchases: subject === "product" ? (purchases.get(item.id) ?? []) : [],
      states: Object.fromEntries(
        graph.collections.map((slug) => [
          slug,
          direct.has(slug)
            ? inherited?.has(slug)
              ? "both"
              : "direct"
            : inherited?.has(slug)
              ? "inherited"
              : "empty",
        ]),
      ) as Record<CollectionSlug, "empty" | "direct" | "inherited" | "both">,
    };
  });

  return { collections: graph.collections, rows, totalCount: source.length };
};

export const setCollectionAssignment = async (
  db: Database,
  actor: ActorContext,
  input: CollectionTagSetInput,
) => {
  if (input.subject === "product") {
    const id = await resolveOrThrow(db, "product", input.id);
    const [row] = await getDb(db)
      .select({ tags: product.tags })
      .from(product)
      .where(and(eq(product.id, id), notDeleted(product)))
      .limit(1);
    if (!row) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `Product not found: ${input.id}`,
      );
    }
    await updateProduct(
      db,
      id,
      { tags: setCollectionTag(row.tags, input.collection, input.assigned) },
      actor,
    );
    return { entityType: "product" as const, entityId: id };
  }

  const id = await resolveOrThrow(db, "location", input.id);
  const [row] = await getDb(db)
    .select({ tags: location.tags })
    .from(location)
    .where(and(eq(location.id, id), notDeleted(location)))
    .limit(1);
  if (!row) {
    throw createAppError(
      "LOCATION_NOT_FOUND",
      `Location not found: ${input.id}`,
    );
  }
  await updateLocation(
    db,
    id,
    { tags: setCollectionTag(row.tags, input.collection, input.assigned) },
    actor,
  );
  return { entityType: "location" as const, entityId: id };
};
