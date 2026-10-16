import type { LocationId } from "@cubby/schemas/identifiers";
import { and, asc, isNull } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { location } from "~/server/db/retained-tables";
import { createAppError } from "~/server/errors/app-error";

/**
 * Resolve Cubby's one real Home location.
 *
 * Home needs no system flag: it is the single live parentless location. Keep
 * this assertion at the repository boundary so a malformed forest fails loudly
 * instead of choosing an arbitrary root.
 */
export async function getHomeLocation(
  db: Database | DrizzleTransaction,
): Promise<{ id: LocationId; shortcode: string; name: string }> {
  const roots = await unwrapDb(db)
    .select({
      id: location.id,
      shortcode: location.shortcode,
      name: location.name,
    })
    .from(location)
    .where(and(isNull(location.parentId), notDeleted(location)))
    .orderBy(asc(location.name))
    .limit(2);

  if (roots.length !== 1) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      roots.length === 0
        ? "Home location is missing"
        : "Expected exactly one Home location, but multiple root locations exist",
    );
  }

  return roots[0]!;
}
