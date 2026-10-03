import type { LocationId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";

import { MAX_TREE_DEPTH } from "./tree-depth";

/**
 * Parenthesized, uncorrelated id subquery holding the selected live Locations
 * and their live descendants. Scoped to the selection (unlike `buildLocationTree`,
 * which walks the whole forest), with the same `deletedAt` pruning and depth cap
 * as the tree walks; the visited-array guard keeps a stored `parentId` cycle from
 * looping. Mirrors `categoryDescendantsSql`.
 */
export const locationDescendantsSql = (selectedIds: readonly LocationId[]) =>
  selectedIds.length === 0
    ? sql<LocationId>`(SELECT NULL::uuid WHERE false)`
    : sql<LocationId>`(
      WITH RECURSIVE descendants AS (
        SELECT l."id", 0 AS depth, ARRAY[l."id"] AS visited
        FROM "Location" l
        WHERE l."id" IN (${sql.join(
          selectedIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND l."deletedAt" IS NULL
        UNION ALL
        SELECT child."id", d.depth + 1, d.visited || child."id"
        FROM descendants d JOIN "Location" child ON child."parentId" = d."id"
        WHERE child."deletedAt" IS NULL AND d.depth < ${sql.raw(String(MAX_TREE_DEPTH))}
          AND NOT child."id" = ANY(d.visited)
      ) SELECT "id" FROM descendants
    )`;
