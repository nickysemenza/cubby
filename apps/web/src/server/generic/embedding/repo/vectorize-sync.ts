import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { entityEmbedding, searchDocument } from "~/server/db/retained-tables";
import type { Claim, PassResult } from "~/server/kernel/api";
import { productionEmbeddingRefreshPort } from "~/server/workflows/background-tasks/embedding";

import { vectorPayloadHash } from "./embedding-artifact";
import { embeddingTextHash } from "./semantic/hash";

export const syncCursor = z
  .object({ entityId: z.uuid(), sourceHash: z.string() })
  .nullable();

/** One source revision, plus remote retirement receipts. All publication is claim-fenced. */
export async function syncVectorize(
  db: Database,
  raw: Parameters<import("~/server/kernel/api").Pass["run"]>[1],
  claim: Claim,
  port = productionEmbeddingRefreshPort,
): Promise<PassResult> {
  const cursor = syncCursor.parse(raw);
  const q = repositoryQueries(db);
  const config = port.config();
  if (cursor) {
    const [doc] = await q
      .select()
      .from(searchDocument)
      .where(
        and(
          eq(searchDocument.entityId, cursor.entityId),
          eq(searchDocument.sourceHash, cursor.sourceHash),
          sql`${searchDocument.deletedAt} IS NULL`,
        ),
      );
    if (doc) {
      const { embeddingAsk } =
        await import("~/server/generic/embedding/module");
      const { withAsk } = await import("~/server/kernel/api");
      const values = await withAsk(
        db,
        {
          ...embeddingAsk,
          produce: async (input) => {
            const [output] = await port.embed([input.text], {
              db,
              feature: "entity_embedding",
              config,
            });
            if (!output) throw new Error("Missing vector");
            return { output };
          },
        },
        {
          entityId: doc.entityId,
          entityKind: doc.entityKind,
          sourceHash: doc.sourceHash,
          text: doc.semanticText,
        },
        {
          record: { entity: doc.entityKind, id: doc.entityId },
          pass: {
            name: "vectorize.sync",
            key: `${doc.entityId}:${doc.sourceHash}`,
          },
        },
      );
      const hash = await embeddingTextHash({
        entityKind: doc.entityKind,
        ...config,
        text: doc.semanticText,
      });
      const artifact = await claim.fenced(async (tx) => {
        const t = repositoryQueries(tx);
        // Serialize against document replacement before selecting or uploading its vector.
        const live = await t.execute<{ id: string }>(
          sql`SELECT id FROM "SearchDocument" WHERE id=${doc.id}::uuid AND "sourceHash"=${doc.sourceHash} AND ${notDeleted("SearchDocument")} FOR UPDATE`,
        );
        if (!live.rows.length) return null;
        const [existing] = await t
          .select()
          .from(entityEmbedding)
          .where(
            and(
              eq(entityEmbedding.entityId, doc.entityId),
              eq(entityEmbedding.artifactHash, hash),
              sql`${entityEmbedding.deletedAt} IS NULL`,
            ),
          );
        if (existing) return existing;
        const [created] = await t
          .insert(entityEmbedding)
          .values({
            entityId: doc.entityId,
            entityKind: doc.entityKind,
            embeddingText: doc.semanticText,
            embeddingHash: hash,
            artifactHash: hash,
            ...config,
            artifactState: "prepared",
          })
          .returning();
        return created ?? null;
      });
      if (artifact && artifact.artifactState !== "selected") {
        if (!artifact.submissionId) {
          const receipts = await port.vectorStore.upsert([
            { id: artifact.id, entityKind: doc.entityKind, values },
          ]);
          const receipt = receipts.get(artifact.id);
          if (!receipt) throw new Error("Vectorize returned no upload receipt");
          const vectorHash = await vectorPayloadHash(values);
          await claim.fenced(async (tx) => {
            await repositoryQueries(tx)
              .update(entityEmbedding)
              .set({
                submissionId: receipt,
                vectorHash,
                artifactState: "submitted",
              })
              .where(eq(entityEmbedding.id, artifact.id));
          });
        }
        const [observed] = await port.vectorStore.getByIds([artifact.id]);
        if (
          !observed ||
          (await vectorPayloadHash(observed.values)) !==
            (await vectorPayloadHash(values))
        )
          return {
            cursor: raw,
            done: false,
            availableAt: new Date(Date.now() + 5000),
            waitCause: "provider_capacity",
          };
        await claim.fenced(async (tx) => {
          const t = repositoryQueries(tx);
          const current = await t.execute<{ id: string }>(
            sql`SELECT id FROM "SearchDocument" WHERE id=${doc.id}::uuid AND "sourceHash"=${doc.sourceHash} AND ${notDeleted("SearchDocument")} FOR UPDATE`,
          );
          await t.execute<{ id: string }>(
            sql`UPDATE "EntityEmbedding" SET "artifactState"=${embeddingArtifactState.enum.retired}, "deletedAt"=now() WHERE "entityId"=${doc.entityId}::uuid AND id<>${artifact.id}::uuid AND ${notDeleted("EntityEmbedding")} AND "artifactState"=${embeddingArtifactState.enum.selected}`,
          );
          await t
            .update(entityEmbedding)
            .set(
              current.rows.length
                ? {
                    artifactState: "selected",
                    observedAt: new Date(),
                    indexedAt: new Date(),
                  }
                : { artifactState: "retired", deletedAt: new Date() },
            )
            .where(eq(entityEmbedding.id, artifact.id));
        });
      }
    }
  }
  const retired = await q
    .select({ id: entityEmbedding.id })
    .from(entityEmbedding)
    .where(
      sql`${entityEmbedding.deletionId} IS NULL AND (${entityEmbedding.deletedAt} IS NOT NULL OR ${entityEmbedding.artifactState} IN (${embeddingArtifactState.enum.retired},${embeddingArtifactState.enum.failed})) AND ${entityEmbedding.artifactState}<>${embeddingArtifactState.enum.selected}`,
    )
    .limit(100);
  if (retired.length) {
    const receipts = await port.vectorStore.deleteByIds(
      retired.map(({ id }) => id),
    );
    await claim.fenced(async (tx) => {
      const { recordEmbeddingDeletions } = await import("./embedding-cleanup");
      await recordEmbeddingDeletions(
        tx,
        [...receipts].map(([id, receipt]) => ({ id, receipt })),
      );
    });
  }
  return { cursor: raw, done: retired.length < 100 };
}
