/**
 * Location lookup and search operations.
 * Find locations by various identifiers (name, shortcode).
 */

import {
  type LocationId,
  unsafeLocationId,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationOut,
  LocationParentOptionsOut,
  LocationType,
} from "@cubby/schemas/location";
import { and, asc, eq, exists, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import { location } from "~/server/db/schema";
import {
  findOrCreate,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

import { getLocationById } from "./crud";
import { dbLocationToAPI } from "./helpers";
import { loadLocationAncestors } from "./tree";

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
    id: unsafeLocationShortcode(row.shortcode),
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
  return id ? getLocationById(db, unsafeLocationId(id)) : null;
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
        parentId,
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
      parentId,
      ...(options?.createdAt && { createdAt: options.createdAt }),
      ...(options?.updatedAt && { updatedAt: options.updatedAt }),
    }),
  });
  return { locationId: row.id, created };
};
