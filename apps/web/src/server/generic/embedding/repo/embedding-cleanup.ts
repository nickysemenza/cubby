import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { jobState } from "@cubby/schemas/job";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { entityEmbedding } from "~/server/db/retained-tables";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";

/** Physical IDs are never selected again after retirement, including explicit retries. */
export async function prepareEmbeddingCleanupPage(
  db: Database,
  after?: string,
  limit = 25,
) {
  const rows = await getDb(db).execute<{ id: string }>(sql`
    SELECT physical.id FROM (
      SELECT e.id FROM "EntityEmbedding" e
      WHERE (e."deletedAt" IS NOT NULL OR e."artifactState" IN (${embeddingArtifactState.enum.retired},${embeddingArtifactState.enum.failed})) AND e."deletionId" IS NULL
      UNION
      SELECT j.id FROM "Job" j WHERE j.kind='embedding.refresh' AND j.state IN (${jobState.enum.completed},${jobState.enum.failed},${jobState.enum.cancelled})
    ) physical
    WHERE ${after ? sql`physical.id > ${after}::uuid` : sql`true`}
      AND NOT EXISTS (SELECT 1 FROM "EntityEmbedding" e WHERE e.id=physical.id AND e."artifactState"=${embeddingArtifactState.enum.selected} AND e."deletedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "Job" active WHERE active.id=physical.id AND active.state IN (${jobState.enum.queued},${jobState.enum.running},${jobState.enum.retry_wait},${jobState.enum.paused}))
      AND NOT EXISTS (SELECT 1 FROM "Job" cleanup WHERE cleanup.key='embedding-cleanup:' || physical.id::text)
    ORDER BY physical.id LIMIT ${limit}`);
  return {
    nextCursor: rows.rows.length === limit ? rows.rows.at(-1)?.id : undefined,
    publish: async (tx: Database) => {
      for (const row of rows.rows)
        await enqueueJob(tx, {
          key: `embedding-cleanup:${row.id}`,
          kind: "embedding.cleanup",
          input: { artifactId: row.id },
        });
    },
  };
}

export async function assertEmbeddingArtifactCanBeDeleted(
  db: Database,
  artifactId: string,
) {
  const [selected] = await getDb(db)
    .select({ id: entityEmbedding.id })
    .from(entityEmbedding)
    .where(
      and(
        eq(entityEmbedding.id, artifactId),
        eq(entityEmbedding.artifactState, "selected"),
        isNull(entityEmbedding.deletedAt),
      ),
    )
    .limit(1);
  if (selected) throw new Error("Cannot delete a selected embedding artifact");
}

export async function recordEmbeddingDeletion(
  db: Database,
  artifactId: string,
  deletionId: string,
) {
  await getDb(db)
    .update(entityEmbedding)
    .set({ artifactState: "retired", deletedAt: new Date(), deletionId })
    .where(
      and(
        eq(entityEmbedding.id, artifactId),
        sql`${entityEmbedding.artifactState} <> ${embeddingArtifactState.enum.selected} OR ${entityEmbedding.deletedAt} IS NOT NULL`,
      ),
    );
}
