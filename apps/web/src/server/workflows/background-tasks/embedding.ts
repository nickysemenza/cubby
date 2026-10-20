import { entityRefKey } from "@cubby/schemas/entity";
import {
  isEmbeddableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { getErrorMessage } from "@cubby/shared";
import { retryWithBackoff } from "@cubby/shared/retry";
import { chunk } from "es-toolkit";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import { ENTITY_EMBEDDING_FEATURE } from "~/server/ai/policy/features";
import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/db/helpers";
import { findPgError } from "~/server/errors/db-errors";
import {
  assertInputRevision,
  currentInputRevision,
  DerivedInputsChanged,
} from "~/server/generic/derived-refresh/repo/freshness";
import {
  claimEmbeddingArtifact,
  deferEmbeddingVisibility,
  failEmbeddingSubmission,
  markEmbeddingSubmitting,
  recordEmbeddingSubmission,
  retireMissingEmbeddingSelections,
  selectEmbeddingArtifact,
  vectorPayloadHash,
  type EmbeddingArtifact,
  embeddingArtifactRecoveryPage,
  deferArtifactRecovery,
  retireEmbeddingArtifact,
  recordArtifactCleanup,
} from "~/server/generic/embedding/repo/embedding-artifact";
import type { EntityEmbeddingUpsert } from "~/server/generic/embedding/repo/entity-embedding-refresh";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import { normalizeSearchText } from "~/server/generic/embedding/repo/semantic/text";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import {
  productionVectorStore,
  type VectorStorePort,
  type StoredVector,
} from "~/server/generic/embedding/service/semantic/vector-store";
import {
  getSearchDocumentEmbeddingTexts,
  prepareSearchDocuments,
  publishPreparedSearchDocuments,
} from "~/server/generic/search/repo/search-document";

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
type EmbeddingRefreshOutcome =
  | "written"
  | "fresh"
  | "missing"
  | "pending"
  | "obsolete"
  | "unconfigured"
  | "notEmbeddable";
export type EmbeddingRefreshResult =
  | { outcome: EmbeddingRefreshOutcome }
  | { error: unknown; throttled: boolean; exhausted?: boolean };

export function isThrottleError<TError>(error: TError): boolean {
  return /\b(40041|429)\b|Too Many Requests|Rate limited/.test(
    getErrorMessage(error),
  );
}
const keyOf = (ref: SearchableEntityRef) =>
  entityRefKey(ref.entityKind, ref.entityId);
const contention = (error: unknown) =>
  error instanceof DerivedInputsChanged ||
  ["55P03", "40P01"].includes(findPgError(error)?.code ?? "");
type ArtifactEntry = {
  input: EntityEmbeddingUpsert;
  artifact: EmbeddingArtifact;
  selected: boolean;
};

async function refreshWave(
  db: Database,
  refs: readonly SearchableEntityRef[],
  port: EmbeddingRefreshPort,
  results: Map<string, EmbeddingRefreshResult>,
) {
  try {
    const revision = await currentInputRevision(db);
    const prepared = await prepareSearchDocuments(db, refs);
    await withTransactionDatabase(db, async (tx) => {
      await publishPreparedSearchDocuments(tx, prepared, revision);
      await assertInputRevision(tx, revision);
    });
  } catch (error) {
    for (const ref of refs)
      results.set(
        keyOf(ref),
        contention(error)
          ? { outcome: "pending" }
          : { error, throttled: isThrottleError(error) },
      );
    return;
  }
  const revision = await currentInputRevision(db);
  const documents = new Map(
    (await getSearchDocumentEmbeddingTexts(db, refs)).map((text) => [
      keyOf(text),
      text,
    ]),
  );
  const claimed: ArtifactEntry[] = [];
  const observe: ArtifactEntry[] = [];
  const missing: SearchableEntityRef[] = [];
  const config = port.config();
  for (const ref of refs) {
    const document = documents.get(keyOf(ref));
    if (!document) {
      missing.push(ref);
      results.set(keyOf(ref), { outcome: "missing" });
      continue;
    }
    if (!isEmbeddableEntity(ref.entityKind)) {
      results.set(keyOf(ref), { outcome: "notEmbeddable" });
      continue;
    }
    if (!port.configured()) {
      results.set(keyOf(ref), { outcome: "unconfigured" });
      continue;
    }
    const embeddingHash = await embeddingTextHash({
      ...ref,
      ...config,
      text: normalizeSearchText(document.embeddingText),
    });
    const input: EntityEmbeddingUpsert = {
      ...document,
      embeddingHash,
      inputRevision: revision,
      config,
    };
    const claim = await claimEmbeddingArtifact(db, input);
    if (claim.kind === "blocked") {
      results.set(keyOf(ref), {
        error: new Error(claim.error),
        throttled: false,
        exhausted: true,
      });
      continue;
    }
    if (claim.kind === "busy") {
      results.set(keyOf(ref), { outcome: "pending" });
      continue;
    }
    const entry = {
      input,
      artifact: claim.artifact,
      selected: claim.kind === "selected",
    };
    if (claim.kind === "claimed") claimed.push(entry);
    else observe.push(entry);
  }
  await retireMissingEmbeddingSelections(db, missing);
  if (claimed.length) {
    try {
      const embeddings = await port.embed(
        claimed.map(({ input }) => normalizeSearchText(input.embeddingText)),
        {
          operation: "entityEmbeddingRefresh",
          db,
          feature: ENTITY_EMBEDDING_FEATURE.feature,
        },
      );
      if (embeddings.length !== claimed.length)
        throw new Error(
          `Embedding provider returned ${embeddings.length} vectors for ${claimed.length} inputs`,
        );
      const vectors: StoredVector[] = [];
      const submitting: ArtifactEntry[] = [];
      for (const [index, entry] of claimed.entries()) {
        const embedding = embeddings[index];
        if (
          !embedding ||
          embedding.length !== config.dimensions ||
          embedding.some((value) => !Number.isFinite(value))
        )
          throw new Error(
            `Invalid embedding vector at input ${index}; expected ${config.dimensions} finite values`,
          );
        const values = embedding.map(Math.fround);
        const artifact = await markEmbeddingSubmitting(
          db,
          entry.artifact,
          await vectorPayloadHash(values),
        );
        if (!artifact) {
          results.set(keyOf(entry.input), { outcome: "obsolete" });
          continue;
        }
        submitting.push({ ...entry, artifact });
        vectors.push({
          id: artifact.id,
          entityKind: entry.input.entityKind,
          values,
        });
      }
      if (vectors.length) {
        // Retries of one physical ID reuse exactly these captured float32 values.
        const receipts = await retryWithBackoff(
          () => port.vectorStore.upsert(vectors),
          {
            delayFor: (outcome, attempt) =>
              outcome.ok || !isThrottleError(outcome.error)
                ? null
                : ([500, 1000, 2000][attempt] ?? null),
          },
        );
        for (const entry of submitting) {
          const receipt = receipts.get(entry.artifact.id);
          if (!receipt)
            throw new Error(
              `Vectorize returned no mutation receipt for artifact ${entry.artifact.id}`,
            );
          const artifact = await recordEmbeddingSubmission(
            db,
            entry.artifact,
            receipt,
          );
          if (artifact) observe.push({ ...entry, artifact });
          else results.set(keyOf(entry.input), { outcome: "obsolete" });
        }
      }
    } catch (error) {
      for (const entry of claimed) {
        const attempts = await failEmbeddingSubmission(
          db,
          entry.artifact,
          entry.input,
          error,
        );
        results.set(keyOf(entry.input), {
          error,
          throttled: isThrottleError(error),
          exhausted: attempts >= 3,
        });
      }
    }
  }
  const due = observe.filter(
    ({ artifact, selected }) => selected || artifact.availableAt <= new Date(),
  );
  for (const entry of observe)
    if (!due.includes(entry))
      results.set(keyOf(entry.input), { outcome: "pending" });
  let observations: Awaited<ReturnType<VectorStorePort["getByIds"]>>;
  try {
    observations = due.length
      ? await port.vectorStore.getByIds(due.map(({ artifact }) => artifact.id))
      : [];
  } catch (error) {
    for (const entry of due) {
      if (entry.selected)
        results.set(keyOf(entry.input), {
          error,
          throttled: isThrottleError(error),
        });
      else {
        await deferEmbeddingVisibility(
          db,
          entry.artifact,
          entry.input,
          JSON.stringify(describeErrorCauses(error)),
        );
        results.set(keyOf(entry.input), { outcome: "pending" });
      }
    }
    return;
  }
  const observed = new Map(observations.map((vector) => [vector.id, vector]));
  for (const entry of due) {
    const vector = observed.get(entry.artifact.id);
    const matches =
      vector &&
      vector.values.length === entry.input.config.dimensions &&
      (await vectorPayloadHash(vector.values)) === entry.artifact.vectorHash;
    if (!matches) {
      if (entry.selected)
        await failEmbeddingSubmission(
          db,
          entry.artifact,
          entry.input,
          new Error(
            `Selected vector artifact ${entry.artifact.id} is absent or differs from its stored payload`,
          ),
        );
      else await deferEmbeddingVisibility(db, entry.artifact, entry.input);
      results.set(keyOf(entry.input), { outcome: "pending" });
      continue;
    }
    if (!entry.selected) {
      try {
        const indexed = await port.vectorStore.queryById(entry.artifact.id, {
          entityKinds: [entry.input.entityKind],
          topK: 100,
        });
        if (!indexed.some((match) => match.id === entry.artifact.id)) {
          await deferEmbeddingVisibility(db, entry.artifact, entry.input);
          results.set(keyOf(entry.input), { outcome: "pending" });
          continue;
        }
        // Positive observation establishes eligibility for approximate search.
      } catch (error) {
        await deferEmbeddingVisibility(
          db,
          entry.artifact,
          entry.input,
          JSON.stringify(describeErrorCauses(error)),
        );
        results.set(keyOf(entry.input), { outcome: "pending" });
        continue;
      }
    }
    if (entry.selected) {
      results.set(keyOf(entry.input), { outcome: "fresh" });
      continue;
    }
    try {
      results.set(keyOf(entry.input), {
        outcome: (await selectEmbeddingArtifact(
          db,
          entry.artifact,
          entry.input,
        ))
          ? "written"
          : "obsolete",
      });
    } catch (error) {
      results.set(
        keyOf(entry.input),
        contention(error)
          ? { outcome: "pending" }
          : { error, throttled: isThrottleError(error) },
      );
    }
  }
}

/** Durable artifact intents precede external work; retries never mutate an older vector ID. */
export async function refreshEntityEmbeddings(
  db: Database,
  refs: ReadonlyArray<SearchableEntityRef>,
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<Map<string, EmbeddingRefreshResult>> {
  const unique = [...new Map(refs.map((ref) => [keyOf(ref), ref])).values()];
  const results = new Map<string, EmbeddingRefreshResult>();
  for (const batch of chunk(unique, 100))
    await refreshWave(db, batch, port, results);
  return results;
}

/** Recover physical work even when its queue message or originating page was lost. */
export async function recoverEmbeddingArtifactsPage(
  db: Database,
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<{ done: boolean; processed: number; errors: string[] }> {
  if (!port.configured()) return { done: true, processed: 0, errors: [] };
  const rows = await embeddingArtifactRecoveryPage(db);
  const cleanup: EmbeddingArtifact[] = [];
  const refresh: SearchableEntityRef[] = [];
  for (const row of rows) {
    if (
      row.artifactState === "retired" ||
      row.artifactState === "failed" ||
      (row.artifactState === "selected" && row.deletedAt)
    ) {
      if (row.artifactState === "selected")
        await retireEmbeddingArtifact(db, row);
      cleanup.push(row);
    } else if (row.artifactState === "legacy") {
      await retireEmbeddingArtifact(db, row);
      cleanup.push(row);
      if (!row.deletedAt) refresh.push(row);
    } else refresh.push(row);
  }
  const errors = new Set<string>();
  if (cleanup.length) {
    const physicalId = (row: EmbeddingArtifact) =>
      row.artifactHash === null ? `${row.entityKind}:${row.entityId}` : row.id;
    try {
      const receipts = await port.vectorStore.deleteByIds(
        cleanup.map(physicalId),
      );
      for (const row of cleanup) {
        const mutationId = receipts.get(physicalId(row));
        if (!mutationId)
          throw new Error(
            `Vectorize returned no deletion receipt for artifact ${row.id}`,
          );
        await recordArtifactCleanup(db, row, { mutationId });
      }
    } catch (error) {
      errors.add(JSON.stringify(describeErrorCauses(error)));
      for (const row of cleanup)
        await recordArtifactCleanup(db, row, { error });
    }
  }
  if (refresh.length) {
    const results = await refreshEntityEmbeddings(db, refresh, port);
    for (const result of results.values())
      if ("error" in result)
        errors.add(JSON.stringify(describeErrorCauses(result.error)));
    await deferArtifactRecovery(
      db,
      rows
        .filter(
          (row) => row.artifactState === "selected" && row.deletedAt === null,
        )
        .map((row) => row.id),
    );
  }
  return {
    done: rows.length < 100,
    processed: rows.length,
    errors: [...errors],
  };
}
