import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { entityEmbedding } from "~/server/db/retained-tables";

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
