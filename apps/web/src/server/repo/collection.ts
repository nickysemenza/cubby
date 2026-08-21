import type {
  CollectionDetailOut,
  CollectionMatrixOut,
  CollectionSlug,
  CollectionSummaryOut,
  CollectionTagSetInput,
} from "@cubby/schemas/collection";
import type { ActorContext } from "@cubby/schemas/context";
import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { setCollectionTag } from "@cubby/shared/collection-tag";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { updateLocation } from "~/server/repo/location";
import { updateProduct } from "~/server/repo/product";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  deriveCollectionMembership,
  directCollectionMembership,
} from "./collection-membership";

interface GraphLocation {
  id: string;
  shortcode: string;
  name: string;
  parentId: string | null;
  productId: string | null;
  tags: string[];
}

interface GraphProduct {
  id: string;
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
  const seen = new Set([loc.id]);
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

  return {
    collection: summarizeCollection(graph, slug),
    roots: graph.locations
      .filter((item) => directCollectionMembership(item.tags).has(slug))
      .map((item) => ({
        id: unsafeLocationShortcode(item.shortcode),
        name: item.name,
        path: locationPath(item, graph.locationsById),
      })),
    totalCount: matchingProducts.length,
    products: matchingProducts
      .slice(start, start + pagination.pageSize)
      .map((item) => {
        const placements = new Map<string, GraphLocation>();
        for (const entry of graph.inventory) {
          if (entry.productId !== item.id) continue;
          const loc = graph.locationsById.get(entry.locationId);
          if (loc) placements.set(loc.id, loc);
        }
        for (const loc of graph.locations) {
          if (loc.productId === item.id) placements.set(loc.id, loc);
        }
        return {
          id: unsafeProductShortcode(item.shortcode),
          name: item.name,
          manufacturer: item.manufacturer,
          direct: directCollectionMembership(item.tags).has(slug),
          inherited: graph.productInherited.get(item.id)?.has(slug) ?? false,
          placements: [...placements.values()].map((loc) => ({
            id: unsafeLocationShortcode(loc.shortcode),
            name: loc.name,
            path: locationPath(loc, graph.locationsById),
          })),
        };
      }),
  };
};

export const getCollectionMatrix = async (
  db: Database,
  subject: "product" | "location",
  search: string | undefined,
  pagination: { pageIndex: number; pageSize: number },
): Promise<CollectionMatrixOut> => {
  const graph = await loadCollectionGraph(db);
  const normalizedSearch = search?.toLocaleLowerCase();
  const source = (
    subject === "product" ? graph.products : graph.locations
  ).filter(
    (item) =>
      !normalizedSearch ||
      item.name.toLocaleLowerCase().includes(normalizedSearch),
  );
  const start = pagination.pageIndex * pagination.pageSize;
  const rows = source.slice(start, start + pagination.pageSize).map((item) => {
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
      secondary:
        subject === "product"
          ? (item as GraphProduct).manufacturer
          : locationPath(item as GraphLocation, graph.locationsById).join(
              " / ",
            ),
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
