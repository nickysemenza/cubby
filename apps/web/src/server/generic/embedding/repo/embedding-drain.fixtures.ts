import type { SearchableEntityRef } from "@cubby/schemas/search";
import { and, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { searchDocument } from "~/server/db/retained-tables";
import { embeddingRefreshDrain } from "~/server/generic/embedding/service/embedding-refresh";
import {
  prepareSearchDocuments,
  publishPreparedSearchDocuments,
} from "~/server/generic/search/repo/search-document";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import {
  enqueueEmbeddingRefs,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

/** The document owes the embedding, so it is published before the mark. */
export async function markEmbeddingFixture(
  db: Database,
  refs: readonly SearchableEntityRef[],
) {
  const prepared = await prepareSearchDocuments(db, refs);
  await publishPreparedSearchDocuments(db, prepared);
  await enqueueEmbeddingRefs(db, prepared);
}

/** What each source still owes: its due time, attempts and last error. */
export const embeddingWorkFor = (db: Database, entityIds: readonly string[]) =>
  getDb(db)
    .select({
      ref: searchDocument.entityId,
      attempts: searchDocument.embeddingAttempts,
      lastError: searchDocument.embeddingError,
      readyAt: searchDocument.embeddingDueAt,
    })
    .from(searchDocument)
    .where(
      and(
        inArray(searchDocument.entityId, [...entityIds]),
        isNotNull(searchDocument.embeddingDueAt),
        isNull(searchDocument.deletedAt),
      ),
    );

/** Advance one source-keyed embedding page; tests move postponed work due explicitly. */
export async function advanceEmbeddingFixture(
  db: Database,
  port: EmbeddingRefreshPort,
) {
  await getDb(db)
    .update(searchDocument)
    .set({ embeddingDueAt: new Date(0) })
    .where(isNotNull(searchDocument.embeddingDueAt));
  await embeddingRefreshDrain(port).page(db, "embedding.refresh");
}

export async function embedFixtures(
  db: Database,
  refs: readonly SearchableEntityRef[],
  port: EmbeddingRefreshPort,
) {
  const uniqueRefs = [
    ...new Map(refs.map((ref) => [ref.entityId, ref])).values(),
  ];
  await markEmbeddingFixture(db, uniqueRefs);
  for (let attempt = 0; attempt < 5; attempt++) {
    await advanceEmbeddingFixture(db, port);
    if (
      !(
        await embeddingWorkFor(
          db,
          uniqueRefs.map((ref) => ref.entityId),
        )
      ).length
    )
      return uniqueRefs;
  }
  throw new Error("Synthetic embedding drain did not settle its work items");
}

/** Search projection publication admits embedding items from the derived drain. */
export async function settleEmbeddingProjectionJobs(db: Database) {
  await drainDerivedRefreshFrontier(db);
}
