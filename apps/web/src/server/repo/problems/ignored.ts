/**
 * Ignored-problem persistence: the set of Problems-page items the user has
 * consciously accepted so they stop re-surfacing. Additive `IgnoredProblem`
 * table keyed by `${sectionId}:${itemId}` (see `problemIgnoreKey`). The detector
 * groups load {@link findIgnoredProblemKeys} once and filter their arrays; the
 * page reads {@link listIgnoredProblems} for the "Ignored (N)" affordance.
 */

import {
  type IgnoredProblemOut,
  problemIgnoreKey,
} from "@cubby/schemas/problems";
import { desc, eq } from "drizzle-orm";
import type { Database } from "~/server/db";
import { ignoredProblem } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/** Every ignored key, as a Set for O(1) membership in the detector filters. */
export const findIgnoredProblemKeys = async (
  db: Database,
): Promise<Set<string>> => {
  const rows = await getDb(db)
    .select({ key: ignoredProblem.key })
    .from(ignoredProblem);
  return new Set(rows.map((r) => r.key));
};

/** Full ignored list (newest first) for the un-ignore affordance. */
export const listIgnoredProblems = async (
  db: Database,
): Promise<IgnoredProblemOut[]> => {
  const rows = await getDb(db)
    .select({
      key: ignoredProblem.key,
      sectionId: ignoredProblem.sectionId,
      itemId: ignoredProblem.itemId,
      createdAt: ignoredProblem.createdAt,
    })
    .from(ignoredProblem)
    .orderBy(desc(ignoredProblem.createdAt));
  return rows;
};

/** Ignore one item. Idempotent — a re-ignore of the same key is a no-op. */
export const ignoreProblem = async (
  db: Database,
  sectionId: string,
  itemId: string,
): Promise<void> => {
  const key = problemIgnoreKey(sectionId, itemId);
  await getDb(db)
    .insert(ignoredProblem)
    .values({ key, sectionId, itemId })
    .onConflictDoNothing({ target: ignoredProblem.key });
};

/** Un-ignore one item by its key (the card re-appears on the next detector run). */
export const unignoreProblem = async (
  db: Database,
  key: string,
): Promise<void> => {
  await getDb(db).delete(ignoredProblem).where(eq(ignoredProblem.key, key));
};
