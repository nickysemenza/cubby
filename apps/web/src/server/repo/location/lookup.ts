/**
 * Location lookup and search operations.
 * Find locations by various identifiers (name, shortcode).
 */

import {
  type LocationId,
  type LocationShortcode,
  type ProductId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationAncestorOut,
  LocationOut,
  LocationParentOptionsOut,
  LocationType,
} from "@cubby/schemas/location";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import {
  and,
  arrayOverlaps,
  asc,
  countDistinct,
  eq,
  exists,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  findOrCreate,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";
import { categorySummarySql } from "~/server/repo/product-category-sql";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

import { getLocationById } from "./crud";
import { dbLocationToAPI } from "./helpers";
import { getHomeLocation } from "./home";
import { parseLocationType } from "./parse-type";
import { loadLocationAncestors } from "./tree";
import { computeLocationValuations } from "./valuation";

// Self-join alias for the child-existence check in `locationParentOptions` —
// the outer query and the EXISTS subquery both read the `location` table, and
// Drizzle needs a distinct name to correlate `child.parentId = location.id`
// instead of both referring to the same unaliased relation (mirrors
// `recipe/crud.ts`'s `parentRecipe` alias for the same self-referential shape).
const childLocation = alias(location, "childLocation");

/**
 * Locations that have at least one LIVE direct child — the bounded roster for
 * the location filter's `parentLocation` picklist (`optionsKey:
 * "parentLocation"`, see `useLocationParentOptions`). Scoped rather than the
 * full ~136-row location table so every option in the picklist actually
 * matches something (~27 rows) and the list stays scannable.
 *
 * Both the outer rows and the child-existence check exclude soft-deleted rows
 * — a location whose only children were soft-deleted (a shelf emptied via
 * delete, not just its inventory) must NOT appear, or the picklist would offer
 * a "parent" filter value that matches zero locations.
 */
export const locationParentOptions = async (
  db: Database,
): Promise<LocationParentOptionsOut[]> => {
  const dbClient = getDb(db);
  const rows = await dbClient
    .select({
      id: location.id,
      shortcode: location.shortcode,
      name: location.name,
    })
    .from(location)
    .where(
      and(
        notDeleted(location),
        exists(
          dbClient
            .select({ one: sql`1` })
            .from(childLocation)
            .where(
              and(
                eq(childLocation.parentId, location.id),
                notDeleted(childLocation),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(location.name));

  // "shelf 1" appears in four rooms; the picklist is unusable without the
  // chain that tells them apart.
  const ancestorsById = await loadLocationAncestors(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: parseShortcodeFor("location", row.shortcode),
    name: row.name,
    ancestors: ancestorsById.get(row.id) ?? [],
  }));
};

/**
 * Get full location details by shortcode. Returns null if the code doesn't
 * resolve to a live location.
 */
export const getLocationByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<InfLocation | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "location");
  return id ? getLocationById(db, parseEntityId("location", id)) : null;
};

/**
 * Fetch multiple locations by shortcodes in a single query.
 * Includes parent name for label display.
 */
export const getLocationsByShortcodes = async (
  db: Database,
  shortcodes: string[],
): Promise<(LocationOut & { parentName: string | null })[]> => {
  if (shortcodes.length === 0) return [];
  const uppercased = shortcodes.map((s) => s.toUpperCase());
  const results = await getDb(db).query.location.findMany({
    where: and(inArray(location.shortcode, uppercased), notDeleted(location)),
    with: {
      ...relations.location.withImages.with,
      parent: true,
    },
  });
  const [valuations, dataQualities] = await Promise.all([
    computeLocationValuations(db),
    loadDataQualities(
      db,
      "location",
      results.map((r) => r.id),
    ),
  ]);
  return results.map((r) => ({
    // SAFETY: `r` came from `results`, which `dataQualities` was loaded for.
    ...dbLocationToAPI(r, valuations, dataQualities.get(r.id)!),
    parentName: r.parent?.name ?? null,
  }));
};

/**
 * Find or create a location by name with optional parent
 * If location exists, returns its ID (does not update type/parent)
 * If location doesn't exist, creates it with the given type and parent
 */
export const findOrCreateLocationByName = async (
  db: Database,
  name: string,
  parentId: LocationId | null,
  type: LocationType,
  options?: {
    /** Optional timestamps to restore from sheet import */
    createdAt?: Date | null;
    updatedAt?: Date | null;
    /** Optional shortcode from import (preserves sheet shortcodes) */
    shortcode?: string;
  },
): Promise<{ locationId: LocationId; created: boolean }> => {
  const resolvedParentId = parentId ?? (await getHomeLocation(db)).id;
  // Atomic find-or-create. The `Location_name_key` unique index is on
  // lower(name) (partial, WHERE deletedAt IS NULL); the match is written as
  // lower(name) = lower(value) (not ilike) so the planner can actually use that
  // functional index. The shortcode thunk only runs on the create path, so
  // existing locations don't burn a shortcode. See findOrCreate.
  const where = and(
    eq(sql`lower(${location.name})`, name.toLowerCase()),
    notDeleted(location),
  );

  // An import/restore replaying an existing shortcode must have it honoured
  // verbatim rather than routed through the fresh-code-per-retry helper below —
  // `findOrCreateWithShortcode` always mints its own code, which would silently
  // drop the caller's.
  if (options?.shortcode !== undefined) {
    const explicitShortcode = options.shortcode;
    const { row, created } = await findOrCreate(db, location, {
      where,
      values: () => ({
        name,
        type,
        parentId: resolvedParentId,
        shortcode: explicitShortcode,
        ...(options?.createdAt && { createdAt: options.createdAt }),
        ...(options?.updatedAt && { updatedAt: options.updatedAt }),
      }),
    });
    return { locationId: row.id, created };
  }

  const { row, created } = await findOrCreateWithShortcode(db, "location", {
    where,
    values: () => ({
      name,
      type,
      parentId: resolvedParentId,
      ...(options?.createdAt && { createdAt: options.createdAt }),
      ...(options?.updatedAt && { updatedAt: options.updatedAt }),
    }),
  });
  return { locationId: row.id, created };
};

/**
 * Every live location, scored as a put-away destination for `productId`.
 *
 * The consumer is the AI location suggester: the model reads the *names* and
 * the ancestor chain (a PACKOUT wall plate belongs on the PACKOUT Wall), and
 * these counts are the corroborating hints under them. They are hints and not
 * a ranking on purpose — backtested against every existing entry, ordering
 * locations by these counts alone lands the right one 22% of the time, because
 * `tools` alone spreads across 72 locations with the leader holding 8%.
 *
 * Every live location is returned, stocked or not: an empty shelf is a
 * perfectly good destination, and the model needs the whole board to choose
 * from. The aggregation is per-location in SQL rather than a fold over raw
 * entries so the interactive call stays one small grouped scan as the ledger
 * grows.
 *
 * Sibling counts are **distinct products excluding the source itself** — the
 * same rule as `getTagSiblingStorage`, for the same reason: a location that
 * holds only this product tells you nothing about where its family lives. The
 * source's own rows raise `holdsProduct` instead. `stockOnly()` throughout,
 * because a fixture wired into a wall is not somewhere to put a spare.
 */
export interface LocationPutAwayCandidate {
  id: LocationShortcode;
  name: string;
  type: LocationType | null;
  /** Root → immediate parent. Empty for a top-level location. */
  ancestors: LocationAncestorOut[];
  /** Distinct products stocked here, source included — "how full is this bin". */
  itemCount: number;
  /** Distinct other products here sharing at least one tag with the source. */
  tagSiblings: number;
  /** Distinct other products here from the same manufacturer. */
  manufacturerSiblings: number;
  /** Distinct other products here in the same category. */
  categorySiblings: number;
  /** The source product is already stocked here. */
  holdsProduct: boolean;
}

export const getLocationPutAwayCandidates = async (
  db: Database,
  productId: ProductId,
): Promise<LocationPutAwayCandidate[]> => {
  const dbClient = getDb(db);

  const [source] = await dbClient
    .select({
      tags: product.tags,
      manufacturer: product.manufacturer,
      categoryId: product.categoryId,
      category: categorySummarySql(sql`${product.categoryId}`),
    })
    .from(product)
    .where(and(eq(product.id, productId), notDeleted(product)))
    .limit(1);
  if (!source) return [];

  const otherProduct = ne(product.id, productId);
  // An empty tag array would render as `tags && '{}'`, which matches nothing
  // but still costs a parameter; say `false` outright instead. Same for the
  // placeholder manufacturer, which is not a shared identity, and a null
  // category, which is not a group.
  const sharesTag =
    source.tags && source.tags.length > 0
      ? arrayOverlaps(product.tags, source.tags)
      : sql`false`;
  const sharesManufacturer =
    source.manufacturer && source.manufacturer !== UNSPECIFIED_MANUFACTURER
      ? eq(product.manufacturer, source.manufacturer)
      : sql`false`;
  const sharesCategory = source.categoryId
    ? eq(product.categoryId, source.categoryId)
    : sql`false`;

  const tallies = await dbClient
    .select({
      locationId: inventoryEntry.locationId,
      itemCount: countDistinct(product.id),
      tagSiblings: sql<number>`count(distinct ${product.id}) filter (where ${sharesTag} and ${otherProduct})::int`,
      manufacturerSiblings: sql<number>`count(distinct ${product.id}) filter (where ${sharesManufacturer} and ${otherProduct})::int`,
      categorySiblings: sql<number>`count(distinct ${product.id}) filter (where ${sharesCategory} and ${otherProduct})::int`,
      holdsProduct: sql<boolean>`bool_or(${product.id} = ${productId})`,
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
      ),
    )
    .groupBy(inventoryEntry.locationId);

  const tallyByLocation = new Map(tallies.map((row) => [row.locationId, row]));

  const rows = await dbClient
    .select({
      id: location.id,
      shortcode: location.shortcode,
      name: location.name,
      type: location.type,
    })
    .from(location)
    .where(notDeleted(location))
    .orderBy(asc(location.name));

  // "shelf 1" exists in four rooms; without the chain the model is choosing
  // between four identical strings.
  const ancestorsById = await loadLocationAncestors(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => {
    const tally = tallyByLocation.get(row.id);
    return {
      id: parseShortcodeFor("location", row.shortcode),
      name: row.name,
      type: parseLocationType(row.type, { id: row.id, name: row.name }),
      ancestors: ancestorsById.get(row.id) ?? [],
      itemCount: tally?.itemCount ?? 0,
      tagSiblings: tally?.tagSiblings ?? 0,
      manufacturerSiblings: tally?.manufacturerSiblings ?? 0,
      categorySiblings: tally?.categorySiblings ?? 0,
      holdsProduct: tally?.holdsProduct ?? false,
    };
  });
};
