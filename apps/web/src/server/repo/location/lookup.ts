/**
 * Location lookup and search operations.
 * Find locations by various identifiers (name, shortcode).
 */

import { desc, eq, ilike, inArray, sql } from "drizzle-orm";

import { dedupe } from "~/misc/array-helpers";
import type { LocationId } from "~/schemas/identifiers";
import { unsafeLocationId } from "~/schemas/identifiers";
import type {
  InfLocation,
  LocationOut,
  LocationType,
} from "~/schemas/location";
import type { Database } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import {
  getDb,
  insertAndReturnDb,
  relations,
} from "~/server/repo/database-helpers";
import { generateUniqueLocationShortcode } from "~/server/repo/shortcode-utils";

import { getLocationById } from "./crud";
import { dbLocationToAPI } from "./helpers";

/**
 * Find a location by its unique name (case-insensitive)
 * Returns null if not found
 */
export const findLocationByName = async (
  db: Database,
  name: string,
): Promise<LocationId | null> => {
  const loc = await getDb(db).query.location.findFirst({
    where: ilike(location.name, name),
  });
  return loc ? unsafeLocationId(loc.id) : null;
};

/**
 * Find a location by its shortcode
 * Returns null if not found
 */
export const findLocationByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<LocationId | null> => {
  const loc = await getDb(db).query.location.findFirst({
    where: eq(location.shortcode, shortcode.toUpperCase()),
  });
  return loc ? unsafeLocationId(loc.id) : null;
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
  },
): Promise<{ locationId: LocationId; created: boolean }> => {
  // Check if location already exists
  const existingId = await findLocationByName(db, name);
  if (existingId) {
    return { locationId: existingId, created: false };
  }

  // Generate unique shortcode
  const shortcode = await generateUniqueLocationShortcode(db);

  // Create new location (with optional timestamps for sheet import)
  const created = await insertAndReturnDb(db, location, {
    name,
    type,
    parentId,
    shortcode,
    ...(options?.createdAt && { createdAt: options.createdAt }),
    ...(options?.updatedAt && { updatedAt: options.updatedAt }),
  });

  return { locationId: unsafeLocationId(created.id), created: true };
};

/**
 * Get recently active locations for the scanner.
 * Combines two data sources:
 * 1. Locations sorted by updatedAt DESC (catches new locations + bulk inventory)
 * 2. Locations with recent inventory activity
 */
export const getRecentlyActiveLocations = async (
  db: Database,
  limit = 5,
): Promise<LocationOut[]> => {
  // Part 1: Recently updated locations
  const recentLocations = await getDb(db)
    .select({ id: location.id })
    .from(location)
    .orderBy(desc(location.updatedAt))
    .limit(limit);

  // Part 2: Locations with recent inventory activity
  // Use subquery to get distinct location IDs ordered by most recent activity
  const inventoryLocations = await getDb(db)
    .select({ id: inventoryEntry.locationId })
    .from(inventoryEntry)
    .groupBy(inventoryEntry.locationId)
    .orderBy(desc(sql`max(${inventoryEntry.updatedAt})`))
    .limit(10);

  // Merge and dedupe by ID, take first N
  const finalIds = dedupe([
    ...recentLocations.map((l) => l.id),
    ...inventoryLocations.map((l) => l.id),
  ]).slice(0, limit);

  if (finalIds.length === 0) {
    return [];
  }

  // Fetch full location data
  const locations = await getDb(db).query.location.findMany({
    where: inArray(location.id, finalIds),
    ...relations.location.withImages,
  });

  return locations.map(dbLocationToAPI);
};
