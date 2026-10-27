import type { SearchableEntityRef } from "@cubby/schemas/search";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job, workItem } from "~/server/db/retained-tables";
import { embeddingRefreshHandler } from "~/server/generic/embedding/service/embedding-refresh";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import {
  EMBEDDING_REFRESH_DRAIN,
  EMBEDDING_REFRESH_TARGET,
  enqueueEmbeddingRefs,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

/** Advance one source-keyed embedding page; tests move postponed work due explicitly. */
export async function advanceEmbeddingFixture(
  db: Database,
  port: EmbeddingRefreshPort,
) {
  const [execution] = await getDb(db)
    .select({ id: job.id })
    .from(job)
    .where(eq(job.key, EMBEDDING_REFRESH_DRAIN.key))
    .limit(1);
  if (!execution) return null;
  await getDb(db)
    .update(job)
    .set({ availableAt: new Date(0) })
    .where(eq(job.id, execution.id));
  await getDb(db)
    .update(workItem)
    .set({ readyAt: new Date(0) })
    .where(eq(workItem.drain, EMBEDDING_REFRESH_DRAIN.key));
  await advanceJob(db, execution.id, {
    "embedding.refresh": embeddingRefreshHandler(port),
  });
  return execution;
}

export async function embedFixtures(
  db: Database,
  refs: readonly SearchableEntityRef[],
  port: EmbeddingRefreshPort,
) {
  const uniqueRefs = [
    ...new Map(refs.map((ref) => [ref.entityId, ref])).values(),
  ];
  await enqueueEmbeddingRefs(db, await prepareSearchDocuments(db, uniqueRefs));
  for (let attempt = 0; attempt < 5; attempt++) {
    await advanceEmbeddingFixture(db, port);
    const pending = await getDb(db)
      .select({ ref: workItem.ref })
      .from(workItem)
      .where(eq(workItem.target, EMBEDDING_REFRESH_TARGET));
    if (
      !pending.some(({ ref }) =>
        uniqueRefs.some((candidate) => candidate.entityId === ref),
      )
    )
      return uniqueRefs;
  }
  throw new Error("Synthetic embedding drain did not settle its work items");
}

/** Search projection publication admits embedding items from the derived drain. */
export async function settleEmbeddingProjectionJobs(db: Database) {
  await drainDerivedRefreshFrontier(db);
}
