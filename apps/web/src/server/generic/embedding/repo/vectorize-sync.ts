import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { askState } from "@cubby/schemas/kernel/machinery";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { entityEmbedding, searchDocument } from "~/server/db/retained-tables";

type Document = typeof searchDocument.$inferSelect;
type Artifact = typeof entityEmbedding.$inferSelect;
export async function loadVectorDocument(
  db: Database,
  cursor: { entityId: string; sourceHash: string },
): Promise<Document | undefined> {
  const [doc] = await repositoryQueries(db)
    .select()
    .from(searchDocument)
    .where(
      and(
        eq(searchDocument.entityId, cursor.entityId),
        eq(searchDocument.sourceHash, cursor.sourceHash),
        notDeleted(searchDocument),
      ),
    );
  return doc;
}
export async function retainedVectorArtifact(
  db: Database,
  entityId: string,
  hash: string,
): Promise<Artifact | undefined> {
  const [row] = await repositoryQueries(db)
    .select()
    .from(entityEmbedding)
    .where(
      and(
        eq(entityEmbedding.entityId, entityId),
        eq(entityEmbedding.artifactHash, hash),
        notDeleted(entityEmbedding),
      ),
    );
  return row;
}
export async function lockVectorDocument(
  db: Database,
  doc: Document,
): Promise<boolean> {
  const result = await repositoryQueries(db).execute<{ id: string }>(
    sql`SELECT id FROM "SearchDocument" WHERE id=${doc.id}::uuid AND "sourceHash"=${doc.sourceHash} AND ${notDeleted("SearchDocument")} FOR UPDATE`,
  );
  return result.rows.length > 0;
}
export async function stageVectorArtifact(
  db: Database,
  doc: Document,
  hash: string,
  config: Pick<Artifact, "provider" | "model" | "dimensions">,
): Promise<Artifact | null> {
  if (!(await lockVectorDocument(db, doc))) return null;
  const existing = await retainedVectorArtifact(db, doc.entityId, hash);
  if (existing) return existing;
  const [created] = await repositoryQueries(db)
    .insert(entityEmbedding)
    .values({
      entityId: doc.entityId,
      entityKind: doc.entityKind,
      embeddingText: doc.semanticText,
      embeddingHash: hash,
      artifactHash: hash,
      ...config,
      artifactState: embeddingArtifactState.enum.prepared,
    })
    .returning();
  return created ?? null;
}
export async function recordVectorUpload(
  db: Database,
  id: string,
  receipt: string,
  vectorHash: string,
): Promise<void> {
  await repositoryQueries(db)
    .update(entityEmbedding)
    .set({
      submissionId: receipt,
      vectorHash,
      artifactState: embeddingArtifactState.enum.submitted,
    })
    .where(eq(entityEmbedding.id, id));
}
export async function selectVisibleVector(
  db: Database,
  doc: Document,
  id: string,
): Promise<void> {
  const q = repositoryQueries(db);
  const current = await lockVectorDocument(db, doc);
  if (current)
    await q.execute(
      sql`UPDATE "EntityEmbedding" SET "artifactState"=${embeddingArtifactState.enum.retired},"deletedAt"=now() WHERE "entityId"=${doc.entityId}::uuid AND id<>${id}::uuid AND ${notDeleted("EntityEmbedding")} AND "artifactState"=${embeddingArtifactState.enum.selected}`,
    );
  await q
    .update(entityEmbedding)
    .set(
      current
        ? {
            artifactState: embeddingArtifactState.enum.selected,
            observedAt: new Date(),
            indexedAt: new Date(),
          }
        : {
            artifactState: embeddingArtifactState.enum.retired,
            deletedAt: new Date(),
          },
    )
    .where(eq(entityEmbedding.id, id));
}
export async function retiredVectorIds(db: Database): Promise<string[]> {
  const rows = await repositoryQueries(db)
    .select({ id: entityEmbedding.id })
    .from(entityEmbedding)
    .where(
      sql`${entityEmbedding.deletionId} IS NULL AND (${entityEmbedding.deletedAt} IS NOT NULL OR ${entityEmbedding.artifactState} IN (${embeddingArtifactState.enum.retired},${embeddingArtifactState.enum.failed})) AND ${entityEmbedding.artifactState}<>${embeddingArtifactState.enum.selected}`,
    )
    .limit(100);
  return rows.map((row) => row.id);
}

/** A result lookup can finish its original interrupted receipt without sending another call. */
export async function vectorLookupClaim(
  db: Database,
  id: string,
): Promise<
  { id: string; token: string | null; executor: string | null } | undefined
> {
  const { ask } = await import("~/server/db/kernel-schema");
  const [row] = await repositoryQueries(db)
    .select({ id: ask.id, token: ask.claimToken, executor: ask.executor })
    .from(ask)
    .where(
      and(
        eq(ask.id, id),
        eq(ask.executor, "vectorize.lookup"),
        sql`${ask.state} IN (${askState.enum.sent},${askState.enum.unknown})`,
        sql`${ask.cancelledAt} IS NULL`,
      ),
    );
  return row;
}
