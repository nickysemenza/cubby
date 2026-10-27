import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { jobState } from "@cubby/schemas/job";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { entityEmbedding } from "~/server/db/retained-tables";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

/** Physical IDs are never selected again after retirement, including explicit retries. */
async function prepareEmbeddingCleanupPage(
  db: Database,
  after?: string,
  limit = 25,
) {
  const rows = await getDb(db).execute<{
    id: string;
    subjectKind: string | null;
    subjectId: string | null;
  }>(sql`
    SELECT physical.id, coalesce(e."entityKind", j."subjectKind") AS "subjectKind", coalesce(e."entityId"::text, j."subjectId") AS "subjectId" FROM (
      SELECT e.id FROM "EntityEmbedding" e
      WHERE (e."deletedAt" IS NOT NULL OR e."artifactState" IN (${embeddingArtifactState.enum.retired},${embeddingArtifactState.enum.failed})) AND e."deletionId" IS NULL
      UNION
      SELECT j.id FROM "Job" j WHERE j.kind='embedding.refresh' AND j.state IN (${jobState.enum.completed},${jobState.enum.failed},${jobState.enum.cancelled})
    ) physical
    LEFT JOIN "EntityEmbedding" e ON e.id=physical.id
    LEFT JOIN "Job" j ON j.id=physical.id
    WHERE ${after ? sql`physical.id > ${after}::uuid` : sql`true`}
      AND NOT EXISTS (SELECT 1 FROM "EntityEmbedding" e WHERE e.id=physical.id AND e."artifactState"=${embeddingArtifactState.enum.selected} AND e."deletedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "Job" active WHERE active.id=physical.id AND active.state IN (${jobState.enum.queued},${jobState.enum.running},${jobState.enum.retry_wait},${jobState.enum.paused}))
      AND NOT EXISTS (SELECT 1 FROM "Job" cleanup WHERE cleanup.key='embedding-cleanup:' || physical.id::text)
    ORDER BY physical.id LIMIT ${limit}`);
  return {
    nextCursor: rows.rows.length === limit ? rows.rows.at(-1)?.id : undefined,
    pending: rows.rows.length,
    publish: async (tx: Database) => {
      for (const row of rows.rows)
        await enqueueJob(tx, {
          key: `embedding-cleanup:${row.id}`,
          kind: "embedding.cleanup",
          subjectKind: row.subjectKind,
          subjectId: row.subjectId,
          input: { artifactId: row.id },
        });
    },
  };
}

/** Queue one page of retired artifacts for physical deletion, in its own transaction. */
export async function queueEmbeddingCleanupPage(
  db: Database,
  after?: string,
  limit = 25,
) {
  const prepared = await prepareEmbeddingCleanupPage(db, after, limit);
  await withTransactionDatabase(db, (tx) => prepared.publish(tx));
  return { queued: prepared.pending, nextCursor: prepared.nextCursor };
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
        // Both retirement cases belong to this artifact, never all deleted rows.
        or(
          ne(
            entityEmbedding.artifactState,
            embeddingArtifactState.enum.selected,
          ),
          isNotNull(entityEmbedding.deletedAt),
        ),
      ),
    );
}
