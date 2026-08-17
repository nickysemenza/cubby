import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
/**
 * Location tree and hierarchy operations.
 * Build location trees, type counts, and import updates.
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  InventoryItemForTree,
  LocationAncestorOut,
} from "@cubby/schemas/location";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  inventoryEntry,
  location,
  locationImage,
  product,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  relations,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";
import { parseLocationType } from "~/server/repo/location/parse-type";
import { buildLocationWithChildren } from "./helpers";
import type { LocationWithParentChild } from "./internal-types";

/** Depth cap shared by both recursive walks over the location tree. */
const MAX_TREE_DEPTH = 10;

/**
 * Build the location hierarchy as `InfLocation` roots.
 *
 * With no `rootId` this is the whole forest (every parentless location).
 * With one, the CTE is anchored at that location and the return value is its
 * CHILDREN — the descendant forest under it, not the anchor itself — which is
 * what a subtree table on a detail page wants to render.
 */
export const buildLocationTree = async (db: Database, rootId?: LocationId) => {
  // Drizzle doesn't support recursive CTEs in the query builder,
  // so we'll use raw SQL for the recursive query
  // Excludes soft-deleted locations
  const res = await getDb(db).execute<LocationWithParentChild>(sql`
    WITH RECURSIVE location_tree AS (
      -- Base case: the anchor location, or every root (excludes soft-deleted)
      SELECT
        l.*,
        0 as depth
      FROM ${location} l
      WHERE ${rootId ? sql`l."id" = ${rootId}` : sql`l."parentId" IS NULL`} AND l."deletedAt" IS NULL

      UNION ALL

      -- Recursive case: children of locations in the tree (excludes soft-deleted)
      SELECT
        l.*,
        lt.depth + 1 as depth
      FROM ${location} l
      INNER JOIN location_tree lt ON l."parentId" = lt.id
      WHERE lt.depth < ${MAX_TREE_DEPTH} AND l."deletedAt" IS NULL
    )
    SELECT * FROM location_tree
    ORDER BY depth, name
  `);

  const locationsMap = new Map<string, LocationWithParentChild>();
  const rootLocations: LocationWithParentChild[] = [];

  const locationRows = res.rows as unknown as (typeof location.$inferSelect)[];

  // Batch fetch all images for all locations in one query to avoid N+1
  const locationIds = locationRows.map((loc) => loc.id);
  const allLocationImages =
    locationIds.length > 0
      ? await getDb(db).query.locationImage.findMany({
          where: inArray(locationImage.locationId, locationIds),
          ...relations.location.withImages.with.images,
        })
      : [];

  const imagesByLocationId = new Map<
    string,
    Array<{ image: typeof image.$inferSelect }>
  >();
  for (const locImg of allLocationImages) {
    const existing = imagesByLocationId.get(locImg.locationId) ?? [];
    existing.push(locImg);
    imagesByLocationId.set(locImg.locationId, existing);
  }

  // Batch fetch inventory entries with product names for all locations (excludes soft-deleted)
  const allInventoryEntries =
    locationIds.length > 0
      ? await getDb(db)
          .select({
            id: inventoryEntry.id,
            shortcode: inventoryEntry.shortcode,
            locationId: inventoryEntry.locationId,
            amount: inventoryEntry.amount,
            productId: inventoryEntry.productId,
            productShortcode: product.shortcode,
            productName: product.name,
          })
          .from(inventoryEntry)
          .innerJoin(product, eq(inventoryEntry.productId, product.id))
          .where(
            and(
              inArray(inventoryEntry.locationId, locationIds),
              notDeleted(inventoryEntry),
              // Installed fixtures aren't stock you can walk over and count —
              // the audit-session root picker must not show "kitchen: 17"
              // then offer 3 rows to count.
              stockOnly(),
            ),
          )
          .orderBy(product.name)
      : [];

  const inventoryByLocationId = new Map<string, InventoryItemForTree[]>();
  const countsByLocationId = new Map<string, number>();
  for (const entry of allInventoryEntries) {
    const existing = inventoryByLocationId.get(entry.locationId) ?? [];
    existing.push({
      id: unsafeInventoryShortcode(entry.shortcode),
      amount: entry.amount,
      productName: entry.productName,
      productId: unsafeProductShortcode(entry.productShortcode),
    });
    inventoryByLocationId.set(entry.locationId, existing);
    countsByLocationId.set(
      entry.locationId,
      (countsByLocationId.get(entry.locationId) ?? 0) + 1,
    );
  }

  for (const loc of locationRows) {
    const locationWithRelations: LocationWithParentChild = {
      ...loc,
      createdAt:
        loc.createdAt instanceof Date
          ? loc.createdAt
          : new Date(loc.createdAt as string),
      updatedAt:
        loc.updatedAt instanceof Date
          ? loc.updatedAt
          : new Date(loc.updatedAt as string),
      deletedAt:
        loc.deletedAt instanceof Date
          ? loc.deletedAt
          : loc.deletedAt
            ? new Date(loc.deletedAt as string)
            : null,
      lastBulkInventory:
        loc.lastBulkInventory instanceof Date
          ? loc.lastBulkInventory
          : loc.lastBulkInventory
            ? new Date(loc.lastBulkInventory as string)
            : null,
      children: [],
      parent: null,
      images: imagesByLocationId.get(loc.id) ?? [],
      directItemCount: countsByLocationId.get(loc.id) ?? 0,
      inventoryItems: inventoryByLocationId.get(loc.id) ?? [],
    };
    locationsMap.set(loc.id, locationWithRelations);
  }

  // Second pass: build parent-child relationships
  for (const loc of locationRows) {
    const current = locationsMap.get(loc.id)!;

    if (loc.parentId) {
      const parent = locationsMap.get(loc.parentId);
      if (parent) {
        current.parent = parent;
        if (!parent.children) {
          parent.children = [];
        }
        parent.children.push(current);
      }
    } else {
      rootLocations.push(current);
    }
  }

  // Anchored: the CTE's own base row is the only node whose parent is outside
  // the result set, so its children are the forest to return. (It can't come
  // from `rootLocations` — the anchor usually HAS a parentId.)
  const roots = rootId
    ? (locationsMap.get(rootId)?.children ?? [])
    : rootLocations;

  const tree: InfLocation[] = roots.map((x) => {
    return buildLocationWithChildren(x, undefined, false);
  });
  return tree;
};

// A type alias, not an interface: `execute<T>` constrains T to
// `Record<string, unknown>`, which an interface can't satisfy implicitly.
type AncestorRow = {
  root: LocationId;
  depth: number;
  shortcode: string;
  name: string;
  type: string;
};

/**
 * Root-first ancestor chain for each of `ids`, batched into ONE query.
 *
 * The upward twin of {@link buildLocationTree}, and the reason `getLocationById`'s
 * per-level `findFirst` loop must not be reused for list-shaped reads: this
 * costs one round-trip for a whole page instead of one per ancestor per row.
 *
 * Deliberately does NOT skip soft-deleted rungs, matching `getLocationById`'s
 * walk. A picker resolves a typed `LOC-` code through that read and a typed
 * name through this one, so any divergence here shows the SAME location two
 * different breadcrumbs depending on how it was found. `Location.parentId` is
 * `must-target-live` (entity-edge-semantics), so a live location under a
 * deleted parent is a referential-liveness violation that
 * `findReferentialLivenessViolations` already reports — it is not a state for
 * two render paths to paper over in two different ways.
 *
 * (`buildLocationTree` does filter deleted rows — going DOWN, a soft-deleted
 * node must not appear as a row at all. Different question.)
 */
export const loadLocationAncestors = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, LocationAncestorOut[]>> => {
  const byId = new Map<LocationId, LocationAncestorOut[]>();
  if (ids.length === 0) return byId;

  const res = await getDb(db).execute<AncestorRow>(sql`
    WITH RECURSIVE ancestors AS (
      -- Base case: the seed rows themselves, carrying their own id as \`root\`
      -- so every ancestor stays attributable to the row that asked for it.
      -- Unaliased on purpose: \`inArray\` renders the real table name, and a
      -- hand-rolled \`IN \${ids}\` would be the row-constructor trap.
      SELECT
        ${location.id} AS root,
        ${location.parentId} AS "parentId",
        0 AS depth,
        ${location.shortcode},
        ${location.name},
        ${location.type}
      FROM ${location}
      WHERE ${inArray(location.id, ids)}

      UNION ALL

      -- Recursive case: walk UP to each row's parent. No deletedAt filter —
      -- see the doc comment: this has to match getLocationById's walk.
      SELECT
        a.root,
        l."parentId" AS "parentId",
        a.depth + 1 AS depth,
        l."shortcode",
        l."name",
        l."type"
      FROM ${location} l
      INNER JOIN ancestors a ON l."id" = a."parentId"
      WHERE a.depth < ${MAX_TREE_DEPTH}
    )
    SELECT root, depth, "shortcode", "name", "type"
    FROM ancestors
    WHERE depth > 0
    ORDER BY root, depth DESC
  `);

  // `depth DESC` already puts the outermost ancestor first, so each group is
  // root → immediate parent in arrival order.
  for (const row of res.rows) {
    const chain = byId.get(row.root);
    const rung: LocationAncestorOut = {
      id: unsafeLocationShortcode(row.shortcode),
      name: row.name,
      type: parseLocationType(row.type, {
        id: row.shortcode,
        name: row.name,
      }),
    };
    if (chain) chain.push(rung);
    else byId.set(row.root, [rung]);
  }
  return byId;
};

/**
 * Check if setting a new parent would create a circular reference
 *
 * Walks up the parent chain from the proposed parent to check if we'd
 * encounter the location being updated (which would create a cycle).
 *
 * @returns true if the change would create a cycle, false if safe
 */
export const wouldCreateParentCycle = async (
  db: Database | DrizzleTransaction,
  locationId: LocationId,
  newParentId: LocationId,
): Promise<boolean> => {
  // Can't be your own parent
  if (locationId === newParentId) {
    return true;
  }

  // Walk up the parent chain from the proposed parent
  let currentId: LocationId | null = newParentId;
  while (currentId) {
    if (currentId === locationId) {
      return true; // Found a cycle
    }
    const parentLocation: { parentId: LocationId | null } | undefined =
      await unwrapDb(db).query.location.findFirst({
        where: eq(location.id, currentId),
        columns: { parentId: true },
      });
    currentId = parentLocation?.parentId ?? null;
  }

  return false;
};
