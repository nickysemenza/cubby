import { inArray } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { searchDocument } from "~/server/db/retained-tables";

/** A document revision owes one kernel pass; repeated admission reuses its Answer. */
export async function markEmbeddingRefresh(
  db: Database,
  entityIds: readonly string[],
) {
  if (!entityIds.length) return;
  const docs = await repositoryQueries(db)
    .select({
      entityId: searchDocument.entityId,
      sourceHash: searchDocument.sourceHash,
    })
    .from(searchDocument)
    .where(inArray(searchDocument.entityId, [...entityIds]));
  const { startPass } = await import("~/server/kernel/api");
  const { vectorizeSync } = await import("~/server/generic/embedding/module");
  for (const doc of docs)
    await startPass(db, vectorizeSync, {
      key: `${doc.entityId}:${doc.sourceHash}`,
      cursor: doc,
    });
}

export async function scheduleVectorCleanup(db: Database) {
  const { startPass } = await import("~/server/kernel/api");
  const { vectorizeSync } = await import("~/server/generic/embedding/module");
  await startPass(db, vectorizeSync, { key: "retired" });
}
