import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { and, inArray, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { entityEmbedding } from "~/server/db/retained-tables";

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

/** Receipts apply only while artifacts remain deletable. */
export async function recordEmbeddingDeletions(
  db: Database,
  receipts: readonly { id: string; receipt: string }[],
) {
  for (let offset = 0; offset < receipts.length; offset += 200) {
    await getDb(db).execute(sql`
      UPDATE "EntityEmbedding" e SET "deletionId" = r.receipt, "deletedAt" = coalesce(e."deletedAt", now()), "artifactState" = ${embeddingArtifactState.enum.retired}
      FROM jsonb_to_recordset(${JSON.stringify(receipts.slice(offset, offset + 200))}::jsonb) AS r(id uuid, receipt text)
      WHERE e.id = r.id AND e."deletionId" IS NULL AND e."artifactState" <> ${embeddingArtifactState.enum.selected}
        AND (e."deletedAt" IS NOT NULL OR e."artifactState" IN (${embeddingArtifactState.enum.retired}, ${embeddingArtifactState.enum.failed}))`);
  }
}
