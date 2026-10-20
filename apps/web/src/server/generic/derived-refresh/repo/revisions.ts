import { inArray, sql } from "drizzle-orm";

import {
  repositoryQueries as unwrapDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { derivedRefreshRevision } from "~/server/db/retained-tables";

export const ALL_INPUT_REVISION_KEY = "all";
export class DerivedInputsChanged extends Error {}

export async function readInputRevisions(
  db: RepositoryQueryInput,
  keys: readonly string[],
) {
  const distinct = [...new Set(keys)].sort();
  if (distinct.length === 0) return [];
  const rows = await unwrapDb(db)
    .select()
    .from(derivedRefreshRevision)
    .where(inArray(derivedRefreshRevision.key, distinct));
  const revisions = new Map(rows.map((row) => [row.key, row.revision]));
  return distinct.map((key) => [key, revisions.get(key) ?? 0] as const);
}

export async function advanceInputRevisions(
  db: RepositoryQueryInput,
  keys: readonly string[],
) {
  const distinct = [...new Set(keys)].sort();
  if (distinct.length === 0) return;
  await unwrapDb(db)
    .insert(derivedRefreshRevision)
    .values(distinct.map((key) => ({ key, revision: 1 })))
    .onConflictDoUpdate({
      target: derivedRefreshRevision.key,
      set: { revision: sql`${derivedRefreshRevision.revision}+1` },
    });
}

export async function currentInputRevision(db: RepositoryQueryInput) {
  return (await readInputRevisions(db, [ALL_INPUT_REVISION_KEY]))[0]?.[1] ?? 0;
}
