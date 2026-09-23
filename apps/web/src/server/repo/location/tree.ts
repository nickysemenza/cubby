/**
 * Location tree and hierarchy operations.
 * Build location trees, type counts, and import updates.
 */
import {
  locationId as locationIdSchema,
  type LocationId,
  parseEntityId,
  parseShortcodeFor,
  productId as productIdSchema,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type {
  InfLocation,
  LocationAncestorOut,
  LocationInventoryBreakdownOut,
} from "@cubby/schemas/location";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityAttachment,
  type image,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  getDb,
  imageOrder,
  mapImages,
  notDeleted,
  relations,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";
import { parseLocationType } from "~/server/repo/location/parse-type";
import { categorySummarySql } from "~/server/repo/product-category-sql";

import { hydrateImageReadProjection } from "../image-read-projection";
import { buildLocationWithChildren } from "./helpers";
import type { LocationWithParentChild } from "./internal-types";
import { loadStockItemsByLocation } from "./stock-items";
import { computeLocationValuations } from "./valuation";

/** Depth cap shared by both recursive walks over the location tree. */
const MAX_TREE_DEPTH = 10;

const locationTreeRowSchema = z.object({
  id: locationIdSchema,
  shortcode: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
  lastBulkInventory: z.coerce.date().nullable(),
  parentId: locationIdSchema.nullable(),
  productId: productIdSchema.nullable(),
  type: z.string().nullable(),
  aiDescription: z.string().nullable(),
  notes: z.string().nullable(),
  depth: z.coerce.number().int().nonnegative(),
});

const ancestorRowSchema = z.object({
  root: locationIdSchema,
  locationId: locationIdSchema,
  depth: z.coerce.number().int().nonnegative(),
  shortcode: z.string(),
  name: z.string(),
  type: z.string().nullable(),
});

const breakdownLocationRowSchema = z.object({
  id: locationIdSchema,
  parentId: locationIdSchema.nullable(),
  shortcode: z.string(),
  name: z.string(),
  type: z.string().nullable(),
});

/**
 * Build the location hierarchy as `InfLocation` roots.
 *
 * With no `rootId` this is the whole forest (every parentless location).
 * With one, the CTE is anchored at that location and the return value is its
 * CHILDREN — the descendant forest under it, not the anchor itself — which is
 * what a subtree table on a detail page wants to render.
 */
export const buildLocationTree = async (db: Database, rootId?: LocationId) => {
  const baseCondition = () =>
    rootId ? sql`l."id" = ${rootId}` : sql`l."parentId" IS NULL`;
  // Drizzle doesn't support recursive CTEs in the query builder,
  // so we'll use raw SQL for the recursive query
  // Excludes soft-deleted locations
  const res = await getDb(db).execute(sql`
    WITH RECURSIVE location_tree AS (
      -- Base case: the anchor location, or every root (excludes soft-deleted)
      SELECT
        l.*,
        0 as depth
      FROM ${location} l
      WHERE ${baseCondition()} AND l."deletedAt" IS NULL

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

  const locationsMap = new Map<LocationId, LocationWithParentChild>();
  const rootLocations: LocationWithParentChild[] = [];

  const locationRows = z.array(locationTreeRowSchema).parse(res.rows);

  // Every tree row may be a physical instance of a Product. Hydrate those
  // identity products (and their displayable cover) as one batch rather than
  // turning each tree node into a relation query.
  const productIds = [
    ...new Set(
      locationRows.flatMap((loc) => (loc.productId ? [loc.productId] : [])),
    ),
  ];
  const loadIdentityProducts = () =>
    productIds.length > 0
      ? getDb(db).query.product.findMany({
          where: and(inArray(product.id, productIds), notDeleted(product)),
          extras: {
            category: categorySummarySql(sql`${product.categoryId}`).as(
              "category",
            ),
          },
          with: {
            images: {
              where: notDeleted(entityAttachment),
              orderBy: imageOrder,
              with: { image: true },
            },
          },
        })
      : Promise.resolve([]);
  const identityProducts = await loadIdentityProducts();
  const productsById = new Map(
    identityProducts.map((identityProduct) => [
      identityProduct.id,
      {
        ...identityProduct,
        // Identity-product cover semantics are displayable-image semantics;
        // PDFs, failed renders, and missing files cannot occupy the slot.
        images: identityProduct.images.filter((association) => {
          const [mapped] = mapImages([association]);
          return mapped ? isDisplayableImageFile(mapped) : false;
        }),
      },
    ]),
  );

  // Batch fetch all images for all locations in one query to avoid N+1
  const locationIds = locationRows.map((loc) => loc.id);
  const loadLocationImages = () =>
    locationIds.length > 0
      ? getDb(db).query.entityAttachment.findMany({
          // Spread first, then override `where`: the preset carries its own
          // `notDeleted` filter, which would otherwise clobber the id predicate
          // and fetch every location's images.
          ...relations.location.withImages.with.images,
          where: and(
            inArray(entityAttachment.subjectEntityId, locationIds),
            notDeleted(entityAttachment),
          ),
        })
      : Promise.resolve([]);
  const [allLocationImages, inventoryByLocationId, valuations, dataQualities] =
    await Promise.all([
      loadLocationImages(),
      // One loader for items and their count, so the tree's `directItemCount`
      // and `inventoryItems` cannot disagree (see `stock-items.ts`).
      loadStockItemsByLocation(db, locationIds),
      // A whole-tree compute, not scoped to `locationIds`: a node's valuation
      // rolls up its ENTIRE subtree, including anything below this query's
      // anchor (or below a node outside it, for a rootId-anchored subtree).
      computeLocationValuations(db),
      loadDataQualities(db, "location", locationIds),
    ]);

  const imagesByLocationId = new Map<
    LocationId,
    Array<{ image: typeof image.$inferSelect }>
  >();
  for (const locImg of allLocationImages) {
    const locationId = parseEntityId("location", locImg.subjectEntityId);
    const existing = imagesByLocationId.get(locationId) ?? [];
    existing.push(locImg);
    imagesByLocationId.set(locationId, existing);
  }

  for (const loc of locationRows) {
    const locationWithRelations: LocationWithParentChild = {
      ...loc,
      children: [],
      parent: null,
      product: loc.productId ? (productsById.get(loc.productId) ?? null) : null,
      images: imagesByLocationId.get(loc.id) ?? [],
      inventoryItems: inventoryByLocationId.get(loc.id) ?? [],
    };
    locationsMap.set(loc.id, locationWithRelations);
  }

  // Second pass: build parent-child relationships
  for (const loc of locationRows) {
    const current = locationsMap.get(loc.id);
    if (!current) {
      throw new Error(`Parsed location tree row was not indexed: ${loc.id}`);
    }

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
    return buildLocationWithChildren(
      x,
      undefined,
      false,
      valuations,
      dataQualities,
    );
  });
  return hydrateImageReadProjection(db, tree);
};

/**
 * An ancestor rung plus its private id. `LocationAncestorOut` is the wire shape
 * and deliberately carries only the public shortcode, but a caller that wants
 * to batch-resolve something per rung — `resolveEntityDisplayImages` keys on
 * uuid — needs the id the CTE already has in hand.
 */
export type LocationAncestorRung = LocationAncestorOut & {
  locationId: LocationId;
};

/**
 * Lightweight, root-included inventory count tree for the location detail
 * drill-down. This deliberately reads no images, products, or inventory row
 * payloads: only the location scalars and grouped stock counts it renders.
 */
export const getLocationInventoryBreakdown = async (
  db: Database,
  rootId: LocationId,
): Promise<LocationInventoryBreakdownOut | null> => {
  const dbClient = getDb(db);
  const treeResult = await dbClient.execute(sql`
    WITH RECURSIVE location_tree AS (
      SELECT l."id", l."parentId", l."shortcode", l."name", l."type", 0 AS depth
      FROM ${location} l
      WHERE l."id" = ${rootId} AND l."deletedAt" IS NULL

      UNION ALL

      SELECT l."id", l."parentId", l."shortcode", l."name", l."type", lt.depth + 1
      FROM ${location} l
      INNER JOIN location_tree lt ON l."parentId" = lt."id"
      WHERE l."deletedAt" IS NULL AND lt.depth < ${MAX_TREE_DEPTH}
    )
    SELECT "id", "parentId", "shortcode", "name", "type"
    FROM location_tree
  `);
  const rows = z.array(breakdownLocationRowSchema).parse(treeResult.rows);
  if (rows.length === 0) return null;

  const ids = rows.map((row) => row.id);
  const directCounts = await dbClient
    .select({
      locationId: inventoryEntry.locationId,
      itemCount: count(),
    })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
    )
    .innerJoin(
      location,
      and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
    )
    .where(
      and(
        inArray(inventoryEntry.locationId, ids),
        notDeleted(inventoryEntry),
        stockOnly(),
      ),
    )
    .groupBy(inventoryEntry.locationId);
  const countsByLocationId = new Map(
    directCounts.map((row) => [row.locationId, Number(row.itemCount)]),
  );

  type MutableNode = Omit<LocationInventoryBreakdownOut, "children"> & {
    parentId: LocationId | null;
    children: MutableNode[];
  };
  const byId = new Map<LocationId, MutableNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: parseShortcodeFor("location", row.shortcode),
      name: row.name,
      type: parseLocationType(row.type, { id: row.shortcode, name: row.name }),
      directItemCount: countsByLocationId.get(row.id) ?? 0,
      totalItemCount: 0,
      children: [],
      parentId: row.parentId,
    });
  }
  for (const [id, node] of byId) {
    if (id === rootId) continue;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
  }
  const root = byId.get(rootId);
  if (!root) return null;

  const finalize = (node: MutableNode): LocationInventoryBreakdownOut => {
    const children = node.children
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(finalize);
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      directItemCount: node.directItemCount,
      totalItemCount:
        node.directItemCount +
        children.reduce((total, child) => total + child.totalItemCount, 0),
      children,
    };
  };
  return finalize(root);
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
export const loadLocationAncestorsWithIds = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, LocationAncestorRung[]>> => {
  const byId = new Map<LocationId, LocationAncestorRung[]>();
  if (ids.length === 0) return byId;

  const res = await getDb(db).execute(sql`
    WITH RECURSIVE ancestors AS (
      -- Base case: the seed rows themselves, carrying their own id as \`root\`
      -- so every ancestor stays attributable to the row that asked for it.
      -- Unaliased on purpose: \`inArray\` renders the real table name, and a
      -- hand-rolled \`IN \${ids}\` would be the row-constructor trap.
      SELECT
        ${location.id} AS root,
        ${location.id} AS "locationId",
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
        l."id" AS "locationId",
        l."parentId" AS "parentId",
        a.depth + 1 AS depth,
        l."shortcode",
        l."name",
        l."type"
      FROM ${location} l
      INNER JOIN ancestors a ON l."id" = a."parentId"
      WHERE a.depth < ${MAX_TREE_DEPTH}
    )
    SELECT root, "locationId", depth, "shortcode", "name", "type"
    FROM ancestors
    WHERE depth > 0
    ORDER BY root, depth DESC
  `);

  // `depth DESC` already puts the outermost ancestor first, so each group is
  // root → immediate parent in arrival order.
  for (const row of z.array(ancestorRowSchema).parse(res.rows)) {
    const chain = byId.get(row.root);
    const rung: LocationAncestorRung = {
      locationId: row.locationId,
      id: parseShortcodeFor("location", row.shortcode),
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
 * {@link loadLocationAncestorsWithIds} narrowed to the wire shape.
 *
 * Most callers render a breadcrumb and nothing more, and handing them a private
 * uuid they would then have to remember not to serialize is a worse default
 * than one strip here.
 */
export const loadLocationAncestors = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, LocationAncestorOut[]>> => {
  const withIds = await loadLocationAncestorsWithIds(db, ids);
  return new Map(
    [...withIds].map(([root, chain]) => [
      root,
      chain.map(({ locationId: _locationId, ...rung }) => rung),
    ]),
  );
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
