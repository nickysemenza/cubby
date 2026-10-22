import { entityRefKey } from "@cubby/schemas/entity";
import { jobState } from "@cubby/schemas/job";
import {
  isEmbeddableEntity,
  searchableEntitySchema,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { repositoryChanged } from "~/server/db/repository-access.boundary";
import { entityEmbedding, job } from "~/server/db/retained-tables";
import { vectorPayloadHash } from "~/server/generic/embedding/repo/embedding-artifact";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import { normalizeSearchText } from "~/server/generic/embedding/repo/semantic/text";
import {
  getSemanticEmbeddingConfig,
  type SemanticEmbeddingConfig,
} from "~/server/generic/embedding/service/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { PreparedJobPage } from "~/server/generic/jobs/types";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";

export interface EmbeddingRefreshPort {
  readonly configured: () => boolean;
  readonly embed: typeof embedTexts;
  readonly config: typeof getSemanticEmbeddingConfig;
  readonly vectorStore: VectorStorePort;
}
export const productionEmbeddingRefreshPort: EmbeddingRefreshPort = {
  configured: semanticEmbeddingsConfigured,
  embed: embedTexts,
  config: getSemanticEmbeddingConfig,
  vectorStore: productionVectorStore,
};
export type EmbeddingRefreshResult = { outcome: "pending" | "unconfigured" };

const embeddingJobInput = z.object({
  entityKind: searchableEntitySchema,
  entityId: z.uuid(),
  hash: z.string(),
  text: z.string(),
  config: z.object({
    provider: z.literal("openai"),
    model: z.enum(["text-embedding-3-small", "text-embedding-3-large"]),
    dimensions: z.number().int().positive(),
  }),
});
const submittedCursor = z.object({
  hash: z.string(),
  mutationId: z.string(),
  submittedAt: z.string(),
});

/** Content-addressed Job IDs are immutable physical vector IDs, including interrupted uploads. */
export async function enqueueEmbeddingRefs(
  db: Database,
  prepared: Awaited<ReturnType<typeof prepareSearchDocuments>>,
  config: SemanticEmbeddingConfig,
) {
  const jobs = [];
  for (const { source, body } of prepared.entries) {
    if (!isEmbeddableEntity(source.entityKind)) continue;
    const text = normalizeSearchText(body);
    const hash = await embeddingTextHash({
      entityKind: source.entityKind,
      ...config,
      text,
    });
    const key = `embedding:${source.entityKind}:${source.entityId}:${hash}`;
    jobs.push(
      await withTransactionDatabase(db, async (tx) => {
        // Returning to earlier text must use a fresh physical upload. Retain
        // stopped history and reject superseded results before publication.
        await getDb(tx).execute(sql`UPDATE "Job" SET
        key=key || ':retired:' || id::text,
        state=CASE WHEN state IN (${jobState.enum.queued},${jobState.enum.retry_wait},${jobState.enum.running}) THEN ${jobState.enum.cancelled} ELSE state END,
        "leaseToken"=NULL, "leaseExpiresAt"=NULL,
        error=coalesce(error,'Embedding source superseded'), "updatedAt"=now()
        WHERE kind='embedding.refresh' AND input->>'entityKind'=${source.entityKind}
          AND input->>'entityId'=${source.entityId} AND input->>'hash'<>${hash}
          AND input->'config'=${JSON.stringify(config)}::jsonb
          AND key NOT LIKE '%:retired:%'`);
        const [existing] = await getDb(tx)
          .select()
          .from(job)
          .where(eq(job.key, key))
          .for("update");
        if (existing?.state === "completed") {
          const [selected] = await getDb(tx)
            .select({ id: entityEmbedding.id })
            .from(entityEmbedding)
            .where(
              and(
                eq(entityEmbedding.id, existing.id),
                eq(entityEmbedding.artifactState, "selected"),
                isNull(entityEmbedding.deletedAt),
              ),
            )
            .limit(1);
          if (!selected)
            await getDb(tx)
              .update(job)
              .set({ key: `${key}:retired:${existing.id}` })
              .where(eq(job.id, existing.id));
        }
        return enqueueJob(tx, {
          key,
          kind: "embedding.refresh",
          subjectKind: source.entityKind,
          subjectId: source.entityId,
          input: {
            entityKind: source.entityKind,
            entityId: source.entityId,
            hash,
            text,
            config: {
              provider: config.provider,
              model: config.model,
              dimensions: config.dimensions,
            },
          },
        });
      }),
    );
  }
  return jobs;
}

export function embeddingJobHandler(
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
) {
  return defineJobHandler(
    embeddingJobInput,
    async (db, claim, input): Promise<PreparedJobPage> => {
      if (!port.configured())
        throw new Error(
          "Embedding provider or Vectorize binding is unavailable",
        );
      const current = await prepareSearchDocuments(db, [input]);
      const text = current.entries[0]?.body;
      if (
        text === undefined ||
        (await embeddingTextHash({
          entityKind: input.entityKind,
          ...input.config,
          text: normalizeSearchText(text),
        })) !== input.hash
      )
        return { page: { done: true, result: { outcome: "obsolete" } } };
      const cursor = claim.cursor ? submittedCursor.parse(claim.cursor) : null;
      if (!cursor) {
        const embedded = await port.embed([input.text], {
          db,
          feature: "entity_embedding",
          entity: input,
        });
        const values = embedded[0];
        if (!values) throw new Error("Embedding provider returned no vector");
        const hash = await vectorPayloadHash(values);
        const receipts = await port.vectorStore.upsert([
          { id: claim.id, entityKind: input.entityKind, values },
        ]);
        const mutationId = receipts.get(claim.id);
        if (!mutationId)
          throw new Error("Vectorize returned no upload receipt");
        return {
          page: {
            done: false,
            cursor: { hash, mutationId, submittedAt: new Date().toISOString() },
            availableAt: new Date(Date.now() + 3_000),
          },
        };
      }
      const [observed] = await port.vectorStore.getByIds([claim.id]);
      if (
        !observed ||
        (await vectorPayloadHash(observed.values)) !== cursor.hash
      ) {
        if (Date.now() - Date.parse(cursor.submittedAt) > 2 * 60_000)
          throw new Error(
            "Vectorize did not expose the uploaded artifact before its visibility deadline",
          );
        return {
          page: {
            done: false,
            cursor,
            availableAt: new Date(Date.now() + 5_000),
          },
        };
      }
      return {
        page: {
          done: true,
          result: {
            outcome: "written",
            mutationId: cursor.mutationId,
            vectorHash: cursor.hash,
          },
        },
        publish: async (tx) => {
          // Writers and removals lock the source before its durable identity.
          // Hold the same rows until commit so deletion cannot pass this check
          // and leave a newly selected vector behind.
          const source = SHORTCODE_TABLE[input.entityKind];
          const [liveSource] = await getDb(tx)
            .select({ id: source.id })
            .from(source)
            .where(and(eq(source.id, input.entityId), isNull(source.deletedAt)))
            .for("share");
          const [liveIdentity] = await getDb(tx)
            .select({ id: entityIdentity.id })
            .from(entityIdentity)
            .where(
              and(
                eq(entityIdentity.id, input.entityId),
                isNull(entityIdentity.deletedAt),
              ),
            )
            .for("share");
          if (!liveSource || !liveIdentity)
            throw new Error("Embedding source was removed before selection");
          const latest = await prepareSearchDocuments(tx, [input]);
          const body = latest.entries[0]?.body;
          if (
            body === undefined ||
            (await embeddingTextHash({
              entityKind: input.entityKind,
              ...input.config,
              text: normalizeSearchText(body),
            })) !== input.hash
          )
            throw new Error("Embedding inputs changed before selection");
          await getDb(tx)
            .update(entityEmbedding)
            .set({ deletedAt: new Date(), artifactState: "retired" })
            .where(
              and(
                eq(entityEmbedding.entityKind, input.entityKind),
                eq(entityEmbedding.entityId, input.entityId),
                isNull(entityEmbedding.deletedAt),
              ),
            );
          await getDb(tx)
            .insert(entityEmbedding)
            .values({
              id: claim.id,
              entityKind: input.entityKind,
              entityId: input.entityId,
              embeddingText: input.text,
              embeddingHash: input.hash,
              artifactHash: input.hash,
              ...input.config,
              artifactState: "selected",
              vectorHash: cursor.hash,
              submissionId: cursor.mutationId,
              observedAt: new Date(),
              indexedAt: new Date(),
              deletedAt: null,
            })
            .onConflictDoUpdate({
              target: entityEmbedding.id,
              set: {
                deletedAt: null,
                artifactState: "selected",
                observedAt: new Date(),
                indexedAt: new Date(),
              },
            });
          await repositoryChanged(tx, [
            input.entityKind,
            "search",
            "relatedData",
            "problems",
          ]);
        },
      };
    },
  );
}

/** Explicit background refresh uses the same Jobs as broad passes. Reads never call this. */
export async function refreshEntityEmbeddings(
  db: Database,
  refs: readonly SearchableEntityRef[],
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<Map<string, EmbeddingRefreshResult>> {
  const results = new Map<string, EmbeddingRefreshResult>();
  if (!port.configured()) {
    for (const ref of refs)
      results.set(entityRefKey(ref.entityKind, ref.entityId), {
        outcome: "unconfigured",
      });
    return results;
  }
  await enqueueEmbeddingRefs(
    db,
    await prepareSearchDocuments(db, refs),
    port.config(),
  );
  await (
    await import("./publish")
  ).wakeJobs({ source: "embedding.explicit-refresh" });
  for (const ref of refs)
    results.set(entityRefKey(ref.entityKind, ref.entityId), {
      outcome: "pending",
    });
  return results;
}
