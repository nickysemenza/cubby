import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { entityEmbedding } from "~/server/db/retained-tables";
import { markWork, workPending } from "~/server/generic/jobs/repo/work-items";

export const EMBEDDING_CLEANUP_DRAIN = {
  key: "embedding:cleanup",
  kind: "embedding.cleanup",
} as const;
export const EMBEDDING_CLEANUP_TARGET = "embedding.cleanup";

/** Mark retired physical vectors for the cleanup drain, leaving retry timing on each item. */
async function prepareEmbeddingCleanupPage(
  db: Database,
  after?: string,
  limit = 25,
) {
  const rows = await getDb(db).execute<{ id: string }>(sql`
    SELECT e.id FROM "EntityEmbedding" e
    WHERE (e."deletedAt" IS NOT NULL OR e."artifactState" IN (
        ${embeddingArtifactState.enum.retired},
        ${embeddingArtifactState.enum.failed}
      ))
      AND e."deletionId" IS NULL
      AND e."artifactState" <> ${embeddingArtifactState.enum.selected}
      AND NOT (e."artifactState" = ${embeddingArtifactState.enum.selected} AND ${notDeleted("e")})
      AND ${after ? sql`e.id > ${after}::uuid` : sql`true`}
      AND NOT ${workPending(EMBEDDING_CLEANUP_TARGET, sql`e.id`)}
    ORDER BY e.id LIMIT ${limit}`);
  const ids = rows.rows.map(({ id }) => id);
  return {
    nextCursor: rows.rows.length === limit ? rows.rows.at(-1)?.id : undefined,
    pending: ids.length,
    publish: (tx: Database) =>
      markWork(
        tx,
        EMBEDDING_CLEANUP_DRAIN,
        ids.map((id) => ({ target: EMBEDDING_CLEANUP_TARGET, ref: id })),
      ),
  };
}

/** Queue one bounded page of artifacts that have no outstanding deletion receipt. */
export async function queueEmbeddingCleanupPage(
  db: Database,
  after?: string,
  limit = 25,
) {
  const prepared = await prepareEmbeddingCleanupPage(db, after, limit);
  await repositoryTransactionDatabase(db, prepared.publish);
  return { queued: prepared.pending, nextCursor: prepared.nextCursor };
}

export async function assertEmbeddingArtifactCanBeDeleted(
  db: Database,
  artifactId: string,
) {
  const [artifact] = await getDb(db)
    .select({
      id: entityEmbedding.id,
      artifactState: entityEmbedding.artifactState,
      deletedAt: entityEmbedding.deletedAt,
      deletionId: entityEmbedding.deletionId,
    })
    .from(entityEmbedding)
    .where(eq(entityEmbedding.id, artifactId))
    .limit(1);
  if (!artifact || artifact.deletionId) return false;
  if (
    artifact.artifactState === embeddingArtifactState.enum.selected &&
    !artifact.deletedAt
  )
    throw new Error("Cannot delete a selected embedding artifact");
  if (
    artifact.artifactState !== embeddingArtifactState.enum.retired &&
    artifact.artifactState !== embeddingArtifactState.enum.failed &&
    !artifact.deletedAt
  )
    return false;
  return true;
}

export async function findDeletableEmbeddingArtifactIds(
  db: Database,
  ids: readonly string[],
) {
  if (!ids.length) return new Set<string>();
  const rows = await getDb(db)
    .select({
      id: entityEmbedding.id,
      artifactState: entityEmbedding.artifactState,
      deletedAt: entityEmbedding.deletedAt,
      deletionId: entityEmbedding.deletionId,
    })
    .from(entityEmbedding)
    .where(
      and(
        inArray(entityEmbedding.id, [...ids]),
        isNull(entityEmbedding.deletionId),
      ),
    );
  return new Set(
    rows
      .filter(
        (row) =>
          row.artifactState !== embeddingArtifactState.enum.selected &&
          (row.deletedAt !== null ||
            row.artifactState === embeddingArtifactState.enum.retired ||
            row.artifactState === embeddingArtifactState.enum.failed),
      )
      .map((row) => row.id),
  );
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
        isNull(entityEmbedding.deletionId),
        ne(entityEmbedding.artifactState, embeddingArtifactState.enum.selected),
        or(
          isNotNull(entityEmbedding.deletedAt),
          inArray(entityEmbedding.artifactState, [
            embeddingArtifactState.enum.retired,
            embeddingArtifactState.enum.failed,
          ]),
        ),
      ),
    );
}
