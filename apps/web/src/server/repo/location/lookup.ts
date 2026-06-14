/**
 * Location lookup and search operations.
 * Find locations by various identifiers (name, shortcode).
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationOut,
  LocationType,
} from "@cubby/schemas/location";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import {
  findOrCreate,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { generateUniqueLocationShortcode } from "~/server/repo/shortcode-utils";

import { getLocationById } from "./crud";
import { dbLocationToAPI } from "./helpers";

/**
 * Find a location by its shortcode
 * Returns null if not found (excludes soft-deleted)
 */
const findLocationByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<LocationId | null> => {
  const loc = await getDb(db).query.location.findFirst({
    where: and(
      eq(location.shortcode, shortcode.toUpperCase()),
      notDeleted(location),
    ),
  });
  return loc ? loc.id : null;
};

/**
 * Get full location details by shortcode
 */
export const getLocationByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<InfLocation | null> => {
  const locationId = await findLocationByShortcode(db, shortcode);
  if (!locationId) {
    return null;
  }
  return getLocationById(db, locationId);
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
  return results.map((r) => ({
    ...dbLocationToAPI(r),
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
  // Atomic find-or-create. The `Location_name_key` unique index is on
  // lower(name) (partial, WHERE deletedAt IS NULL); the match is written as
  // lower(name) = lower(value) (not ilike) so the planner can actually use that
  // functional index. The shortcode thunk only runs on the create path, so
  // existing locations don't burn a shortcode. See findOrCreate.
  const { row, created } = await findOrCreate(db, location, {
    where: and(
      eq(sql`lower(${location.name})`, name.toLowerCase()),
      notDeleted(location),
    ),
    values: async () => ({
      name,
      type,
      parentId,
      shortcode:
        options?.shortcode ?? (await generateUniqueLocationShortcode(db)),
      ...(options?.createdAt && { createdAt: options.createdAt }),
      ...(options?.updatedAt && { updatedAt: options.updatedAt }),
    }),
  });
  return { locationId: row.id, created };
};

/**
 * Get recently active locations for the scanner.
 * Combines two data sources:
 * 1. Locations sorted by updatedAt DESC (catches new locations + bulk inventory)
 * 2. Locations with recent inventory activity
 * Excludes soft-deleted locations and inventory entries.
 */
export const getRecentlyActiveLocations = async (
  db: Database,
  limit = 5,
): Promise<LocationOut[]> => {
  // Part 1: Recently updated locations (excludes soft-deleted)
  const recentLocations = await getDb(db)
    .select({ id: location.id })
    .from(location)
    .where(notDeleted(location))
    .orderBy(desc(location.updatedAt))
    .limit(limit);

  // Part 2: Locations with recent inventory activity (excludes soft-deleted inventory)
  // Use subquery to get distinct location IDs ordered by most recent activity
  const inventoryLocations = await getDb(db)
    .select({ id: inventoryEntry.locationId })
    .from(inventoryEntry)
    .where(notDeleted(inventoryEntry))
    .groupBy(inventoryEntry.locationId)
    .orderBy(desc(sql`max(${inventoryEntry.updatedAt})`))
    .limit(10);

  // Merge and dedupe by ID, take first N
  const finalIds = uniq([
    ...recentLocations.map((l) => l.id),
    ...inventoryLocations.map((l) => l.id),
  ]).slice(0, limit);

  if (finalIds.length === 0) {
    return [];
  }

  // Fetch full location data (excludes soft-deleted)
  const locations = await getDb(db).query.location.findMany({
    where: and(inArray(location.id, finalIds), notDeleted(location)),
    ...relations.location.withImages,
  });

  return locations.map(dbLocationToAPI);
};
