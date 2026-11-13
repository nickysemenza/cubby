import type { SearchableEntityRef } from "@cubby/schemas/search";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
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

/** Inspect the kernel pass waiting for these source revisions. */
export async function embeddingWorkFor(
  db: Database,
  entityIds: readonly string[],
) {
  const rows = await getDb(db).execute<{
    ref: string;
    attempts: number;
    lastError: string | null;
    readyAt: Date;
  }>(
    sql`SELECT cursor->>'entityId' AS ref, attempts, "lastError", "availableAt" AS "readyAt" FROM "Pass" WHERE name='vectorize.sync' AND "doneAt" IS NULL AND cursor->>'entityId'=ANY(${textArrayParam(entityIds)})`,
  );
  return rows.rows;
}

/** The real kernel claim/Answer/pass path with only provider and vector storage faked. */
export async function advanceEmbeddingFixture(
  db: Database,
  port: EmbeddingRefreshPort,
) {
  const { createKernel, defineModule } = await import("~/server/kernel/api");
  const { embeddingAsk, vectorizeSync } =
    await import("~/server/generic/embedding/module");
  const { syncVectorize } = await import("./vectorize-sync");
  await getDb(db).execute(
    sql`UPDATE "Pass" SET "availableAt"=now() WHERE name='vectorize.sync' AND "doneAt" IS NULL`,
  );
  const kernel = createKernel([
    defineModule({
      name: "embedding",
      asks: [embeddingAsk],
      passes: [
        {
          ...vectorizeSync,
          run: (d, cursor, claim) => syncVectorize(d, cursor, claim, port),
        },
      ],
    }),
  ]);
  await kernel.run(db, { budgetMs: 1000 });
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
