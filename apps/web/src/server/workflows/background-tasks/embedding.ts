import { entityRefKey } from "@cubby/schemas/entity";
import { jobState } from "@cubby/schemas/job";
import {
  isEmbeddableEntity,
  searchableEntitySchema,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { entityEmbedding, job } from "~/server/db/retained-tables";
import { recordChange } from "~/server/generic/changes/repo/change";
import { vectorPayloadHash } from "~/server/generic/embedding/repo/embedding-artifact";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
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
import { withJobExecution } from "~/server/generic/jobs/context";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import type { JobClaim } from "~/server/generic/jobs/repo/jobs";
import type { JobHandler, PreparedJobPage } from "~/server/generic/jobs/types";
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
    // Parse retired snapshots so execution can re-admit them instead of failing.
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
  const inputs: {
    source: (typeof prepared.entries)[number]["source"];
    text: string;
    hash: string;
    key: string;
  }[] = [];
  for (const { source, body } of prepared.entries) {
    if (!isEmbeddableEntity(source.entityKind)) continue;
    const text = normalizeSearchText(body);
    const hash = await embeddingTextHash({
      entityKind: source.entityKind,
      ...config,
      text,
    });
    const key = `embedding:${source.entityKind}:${source.entityId}:${hash}`;
    inputs.push({ source, text, hash, key });
  }
  if (inputs.length === 0) return [];
  return withTransactionDatabase(db, async (tx) => {
    const records = JSON.stringify(
      inputs.map(({ source, hash }) => ({
        entityKind: source.entityKind,
        entityId: source.entityId,
        hash,
      })),
    );
    // Lock overlapping cohorts in one order before retiring any old hashes.
    // Match indexed subjects, not JSON identity: the latter scans every
    // embedding Job even when a small publication admits only one record.
    const existing = await getDb(tx)
      .select({
        id: job.id,
        key: job.key,
        kind: job.kind,
        state: job.state,
        subjectId: job.subjectId,
      })
      .from(job)
      .where(
        or(
          inArray(
            job.key,
            inputs.map((input) => input.key),
          ),
          and(
            eq(job.kind, "embedding.refresh"),
            sql`${job.input}->'config' = ${JSON.stringify(config)}::jsonb`,
            sql`${job.key} NOT LIKE '%:retired:%'`,
            or(
              ...inputs.map(({ source }) =>
                and(
                  eq(job.subjectKind, source.entityKind),
                  eq(job.subjectId, source.entityId),
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(job.key)
      .for("update");
    if (existing.some((row) => row.kind !== "embedding.refresh"))
      throw new Error("Embedding key belongs to a different Job kind");
    await getDb(tx).execute(sql`UPDATE "Job" j SET
      key=j.key || ':retired:' || j.id::text,
      state=CASE WHEN j.state IN (${jobState.enum.queued},${jobState.enum.retry_wait},${jobState.enum.running}) THEN ${jobState.enum.cancelled} ELSE j.state END,
      "leaseToken"=NULL, "leaseExpiresAt"=NULL,
      error=coalesce(j.error,'Embedding source superseded'), "updatedAt"=now()
      FROM jsonb_to_recordset(${records}::jsonb) AS i("entityKind" text, "entityId" text, hash text)
      WHERE j.kind='embedding.refresh' AND j."subjectKind"=i."entityKind"
        AND j."subjectId"=i."entityId" AND j.input->>'hash'<>i.hash
        AND j.input->'config'=${JSON.stringify(config)}::jsonb
        AND j.key NOT LIKE '%:retired:%'`);
    const byKey = new Map(existing.map((row) => [row.key, row]));
    const completed = inputs.flatMap(({ key }) => {
      const row = byKey.get(key);
      return row?.state === "completed" ? [row] : [];
    });
    const selected = new Set(
      (completed.length
        ? await getDb(tx)
            .select({ id: entityEmbedding.id })
            .from(entityEmbedding)
            .where(
              and(
                inArray(
                  entityEmbedding.id,
                  completed.map((row) => row.id),
                ),
                eq(entityEmbedding.artifactState, "selected"),
                isNull(entityEmbedding.deletedAt),
              ),
            )
        : []
      ).map((row) => row.id),
    );
    const retired = completed.filter((row) => !selected.has(row.id));
    // A completed upload that is no longer selected needs a fresh physical ID.
    if (retired.length)
      await getDb(tx)
        .update(job)
        .set({
          key: sql`${job.key} || ':retired:' || ${job.id}::text`,
        })
        .where(
          inArray(
            job.id,
            retired.map((row) => row.id),
          ),
        );
    const jobs = [];
    for (const { source, text, hash, key } of inputs) {
      const current = byKey.get(key);
      if (
        current &&
        (current.state !== "completed" || selected.has(current.id))
      )
        jobs.push(current);
      else
        jobs.push(
          await enqueueJob(tx, {
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
          }),
        );
    }
    return jobs;
  });
}

/** OpenAI permits 2,048 inputs and 300,000 total tokens per request. */
const EMBEDDING_BATCH_SIZE = jobKindPolicy("embedding.refresh").batchSize ?? 1;
const EMBEDDING_REQUEST_TOKEN_LIMIT = 300_000;
const EMBEDDING_INPUT_TOKEN_LIMIT = 8_192;
type EmbeddingSubmission = {
  claim: JobClaim;
  input: z.output<typeof embeddingJobInput>;
};

export function embeddingJobHandler(
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): JobHandler {
  async function prepare(
    claim: JobClaim,
    input: z.output<typeof embeddingJobInput>,
    observed:
      | Awaited<ReturnType<VectorStorePort["getByIds"]>>[number]
      | undefined,
  ): Promise<PreparedJobPage | EmbeddingSubmission> {
    const cursor = claim.cursor ? submittedCursor.parse(claim.cursor) : null;
    if (!cursor) return { claim, input };
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
        await recordChange(tx, {
          kind: "projection",
          categories: [input.entityKind, "search", "relatedData", "problems"],
        });
      },
    };
  }

  async function executeBatch(
    db: Database,
    claims: readonly JobClaim[],
    context: Parameters<NonNullable<JobHandler["batch"]>["execute"]>[2],
  ) {
    const results = new Map<string, PromiseSettledResult<PreparedJobPage>>();
    if (!port.configured())
      throw new Error("Embedding provider or Vectorize binding is unavailable");
    const config = port.config();
    const parsed: EmbeddingSubmission[] = [];
    for (const claim of claims) {
      try {
        parsed.push({ claim, input: embeddingJobInput.parse(claim.input) });
      } catch (reason) {
        results.set(claim.id, { status: "rejected", reason });
      }
    }
    const current = await prepareSearchDocuments(
      db,
      parsed.map(({ input }) => input),
    );
    const bodies = new Map(
      current.entries.map(({ source, body }) => [
        entityRefKey(source.entityKind, source.entityId),
        body,
      ]),
    );
    for (const { claim, input } of parsed) {
      try {
        if (
          input.config.provider !== config.provider ||
          input.config.model !== config.model ||
          input.config.dimensions !== config.dimensions
        ) {
          results.set(claim.id, {
            status: "fulfilled",
            value: {
              page: { done: true, result: { outcome: "obsolete" } },
              // Re-admit only while this Job still owns publication. A cancelled
              // claim must not create replacement work behind the member's stop.
              publish: async (tx) => {
                await enqueueEmbeddingRefs(
                  tx,
                  await prepareSearchDocuments(tx, [input]),
                  config,
                );
              },
            },
          });
          continue;
        }
        const text = bodies.get(entityRefKey(input.entityKind, input.entityId));
        if (
          text === undefined ||
          (await embeddingTextHash({
            entityKind: input.entityKind,
            ...input.config,
            text: normalizeSearchText(text),
          })) !== input.hash
        )
          results.set(claim.id, {
            status: "fulfilled",
            value: { page: { done: true, result: { outcome: "obsolete" } } },
          });
      } catch (reason) {
        results.set(claim.id, { status: "rejected", reason });
      }
    }
    const submitted = parsed.filter(
      ({ claim }) => !results.has(claim.id) && claim.cursor !== null,
    );
    const observed = new Map<
      string,
      Awaited<ReturnType<VectorStorePort["getByIds"]>>[number]
    >();
    if (submitted.length) {
      try {
        for (const vector of await port.vectorStore.getByIds(
          submitted.map(({ claim }) => claim.id),
        ))
          observed.set(vector.id, vector);
      } catch (reason) {
        for (const { claim } of submitted)
          results.set(claim.id, { status: "rejected", reason });
      }
    }
    const submissions: EmbeddingSubmission[] = [];
    for (const { claim, input } of parsed) {
      if (results.has(claim.id)) continue;
      try {
        const prepared = await withJobExecution(db, claim, () =>
          prepare(claim, input, observed.get(claim.id)),
        );
        if ("page" in prepared) {
          results.set(claim.id, { status: "fulfilled", value: prepared });
        } else {
          submissions.push(prepared);
        }
      } catch (reason) {
        results.set(claim.id, { status: "rejected", reason });
      }
    }
    if (results.size) {
      await context.checkpoint(results);
      results.clear();
    }
    let chunk: EmbeddingSubmission[] = [];
    let bytes = 0;
    const flush = async () => {
      if (!chunk.length) return true;
      if (Date.now() >= context.deadline) return false;
      const entries = chunk;
      chunk = [];
      bytes = 0;
      try {
        const first = entries[0]!;
        const vectors = await port.embed(
          entries.map(({ input }) => input.text),
          {
            db,
            feature: "entity_embedding",
            config,
            // A batch usage row describes the call, not an arbitrary first entity.
            ...(entries.length === 1 ? { entity: first.input } : {}),
          },
        );
        if (vectors.length !== entries.length)
          throw new Error("Embedding provider returned an incomplete batch");
        const uploads = entries.map(({ claim, input }, index) => ({
          id: claim.id,
          entityKind: input.entityKind,
          values: vectors[index]!,
        }));
        const receipts = await port.vectorStore.upsert(uploads);
        for (const [index, entry] of entries.entries()) {
          try {
            const mutationId = receipts.get(entry.claim.id);
            if (!mutationId)
              throw new Error("Vectorize returned no upload receipt");
            results.set(entry.claim.id, {
              status: "fulfilled",
              value: {
                page: {
                  done: false,
                  cursor: {
                    hash: await vectorPayloadHash(vectors[index]!),
                    mutationId,
                    submittedAt: new Date().toISOString(),
                  },
                  availableAt: new Date(Date.now() + 3_000),
                },
              },
            });
          } catch (reason) {
            results.set(entry.claim.id, { status: "rejected", reason });
          }
        }
      } catch (reason) {
        for (const entry of entries)
          results.set(entry.claim.id, { status: "rejected", reason });
      }
      // Persist receipts before the next provider call, including the last
      // in-flight chunk when its call crossed the drain deadline.
      await context.checkpoint(results);
      results.clear();
      return true;
    };
    for (const entry of submissions) {
      // BPE tokens cannot outnumber UTF-8 bytes. Long individual inputs run
      // alone: preserve provider validation without poisoning their neighbors.
      const inputBytes = new TextEncoder().encode(entry.input.text).length;
      if (
        (chunk.length >= EMBEDDING_BATCH_SIZE ||
          bytes + inputBytes > EMBEDDING_REQUEST_TOKEN_LIMIT ||
          inputBytes > EMBEDDING_INPUT_TOKEN_LIMIT) &&
        !(await flush())
      )
        return;
      chunk.push(entry);
      bytes += inputBytes;
      if (inputBytes > EMBEDDING_INPUT_TOKEN_LIMIT && !(await flush())) return;
    }
    await flush();
  }
  return {
    batch: { size: EMBEDDING_BATCH_SIZE, execute: executeBatch },
    prepare: async (db, claim) => {
      const results = new Map<string, PromiseSettledResult<PreparedJobPage>>();
      await executeBatch(db, [claim], {
        deadline: Infinity,
        checkpoint: async (pages) => {
          for (const [id, page] of pages) results.set(id, page);
        },
      });
      const result = results.get(claim.id);
      if (!result) throw new Error("Embedding preparation omitted a Job");
      if (result.status === "rejected") throw result.reason;
      return result.value;
    },
  };
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
