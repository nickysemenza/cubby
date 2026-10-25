import { parseEntityId } from "@cubby/schemas/identifiers";
import type { SearchableEntityRef } from "@cubby/schemas/search";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";
import {
  embeddingJobHandler,
  enqueueEmbeddingRefs,
  type EmbeddingRefreshPort,
} from "~/server/workflows/background-tasks/embedding";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

/** Explicit fixture time advancement; production due times remain authoritative. */
export async function advanceEmbeddingFixture(
  db: Database,
  id: string,
  port: EmbeddingRefreshPort,
) {
  await getDb(db)
    .update(job)
    .set({ availableAt: new Date(0) })
    .where(eq(job.id, parseEntityId("job", id)));
  await advanceJob(db, id, { "embedding.refresh": embeddingJobHandler(port) });
  const [saved] = await getDb(db)
    .select()
    .from(job)
    .where(eq(job.id, parseEntityId("job", id)));
  if (!saved) throw new Error("Missing synthetic embedding execution");
  return saved;
}

export async function embedFixtures(
  db: Database,
  refs: readonly SearchableEntityRef[],
  port: EmbeddingRefreshPort,
) {
  const jobs = await enqueueEmbeddingRefs(
    db,
    await prepareSearchDocuments(db, refs),
    port.config(),
  );
  for (const saved of jobs) {
    await advanceEmbeddingFixture(db, saved.id, port);
    await advanceEmbeddingFixture(db, saved.id, port);
  }
  return jobs;
}

/** Fixture seeding satisfies broad admission through the same bounded family. */
export async function settleEmbeddingProjectionJobs(db: Database) {
  await drainDerivedRefreshFrontier(db);
  const [pending] = await getDb(db)
    .select()
    .from(job)
    .where(eq(job.key, "refresh:embeddings"));
  if (!pending || pending.state === "completed") return;
  for (let page = 0; page < 1000; page++) {
    await advanceJob(db, pending.id, {
      "refresh.family": refreshFamilyHandler,
    });
    const [saved] = await getDb(db)
      .select()
      .from(job)
      .where(eq(job.id, pending.id));
    if (saved?.state === "completed") return;
    if (!saved || ["failed", "paused", "cancelled"].includes(saved.state))
      throw new Error(saved?.error ?? "Synthetic embedding family stopped");
  }
  throw new Error("Synthetic embedding family did not finish");
}
