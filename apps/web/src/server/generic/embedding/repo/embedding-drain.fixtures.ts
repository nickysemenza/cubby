import type { SearchableEntityRef } from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import {
  EMBEDDING_REFRESH_DRAIN,
  EMBEDDING_REFRESH_TARGET,
} from "~/server/generic/embedding/repo/embedding-drain";
import { embeddingRefreshHandler } from "~/server/generic/embedding/service/embedding-refresh";
import {
  updateJobs,
  updateWorkItems,
  readWorkItems,
} from "~/server/generic/jobs/jobs.fixtures";
import { readJob } from "~/server/generic/jobs/repo/job-reads";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import {
  enqueueEmbeddingRefs,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";

/** Advance one source-keyed embedding page; tests move postponed work due explicitly. */
export async function advanceEmbeddingFixture(
  db: Database,
  port: EmbeddingRefreshPort,
) {
  const execution = await readJob(db, { key: EMBEDDING_REFRESH_DRAIN.key });
  if (!execution) return null;
  await updateJobs(db, { id: execution.id }, { availableAt: new Date(0) });
  await updateWorkItems(
    db,
    { drain: EMBEDDING_REFRESH_DRAIN.key },
    { readyAt: new Date(0) },
  );
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
    const pending = await readWorkItems(db, {
      target: EMBEDDING_REFRESH_TARGET,
    });
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
