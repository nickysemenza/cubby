import { entityRefKey } from "@cubby/schemas/entity";
import {
  isEmbeddableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";

import { getErrorMessage } from "~/lib/error-utils";
import { ENTITY_EMBEDDING_FEATURE } from "~/server/ai/features";
import type { Database } from "~/server/db";
import {
  getStoredEmbeddingHashes,
  type SearchableEntityText,
  upsertEntityEmbeddingsIfCurrent,
} from "~/server/repo/entity-embedding-refresh";
import {
  getSearchDocumentEmbeddingTexts,
  refreshSearchDocuments,
} from "~/server/repo/search-document";
import {
  getSemanticEmbeddingConfig,
  type SemanticEmbeddingConfig,
} from "~/server/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { embeddingTextHash } from "~/server/semantic/hash";
import { normalizeSearchText } from "~/server/semantic/text";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/semantic/vector-store";

/**
 * The embedding provider and the vector store are the genuinely external
 * seams in this pipeline; tests substitute them and nothing else.
 */
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
  /** A vector for the current projection was stored. */
  | "written"
  /** The stored vector already matches the current projection. */
  | "fresh"
  /** No live document: the entity is gone or was never projected. */
  | "missing"
  /** The projection kept changing across every retry; not retried further. */
  | "obsolete"
  /** No provider credentials in this environment. */
  | "unconfigured"
  /** Searchable but excluded from embedding (the financial entities). */
  | "notEmbeddable";

/**
 * Bounds the obsolete-projection repair loop below. One extra attempt beyond
 * the first covers the ordinary race (this batch's own vector upsert
 * clobbering a concurrent writer's fresher one, see `rehashForRepair`); it is
 * not meant to converge an entity under continuous rewrite.
 */
const MAX_EMBED_ATTEMPTS = 3;

export type EmbeddingRefreshResult =
  | { outcome: EmbeddingRefreshOutcome }
  | { error: unknown; throttled: boolean };

/**
 * Vectorize's mutation rate limit (`VECTOR_UPSERT_ERROR 40041`), a generic
 * HTTP 429, and the AI Gateway's own throttle (`429 … 2018 Wholesale Rate
 * limited`) all surface as a throttle that should be retried in place, not
 * treated the same as a malformed request or a genuine outage. One
 * classifier covers both the embed call and the vector upsert.
 */
export function isThrottleError<TError>(error: TError): boolean {
  return /\b(40041|429)\b|Too Many Requests|Rate limited/.test(
    getErrorMessage(error),
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before each retry of a throttled Vectorize upsert; see
 * {@link upsertVectorsWithRetry}. */
const VECTOR_UPSERT_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * Retry a whole-batch Vectorize upsert through a throttle instead of letting
 * it fail the batch outright: the embed call above already paid the provider
 * for every vector in it, and the queue's own retry would re-embed (and
 * re-pay for) the same text rather than simply re-attempting the write. Only
 * a rate-limit signature is retried; any other error fails fast.
 */
async function upsertVectorsWithRetry(
  port: EmbeddingRefreshPort,
  vectors: ReadonlyArray<SearchableEntityRef & { values: number[] }>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await port.vectorStore.upsert(vectors);
      return { ok: true };
    } catch (error) {
      const delayMs = VECTOR_UPSERT_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isThrottleError(error)) {
        return { ok: false, error };
      }
      await sleep(delayMs + Math.random() * 250);
    }
  }
}

/** Set the same `{ error, throttled }` result for every ref in a failed batch. */
function setErrorForRefs<TError>(
  results: Map<string, EmbeddingRefreshResult>,
  refs: ReadonlyArray<SearchableEntityRef>,
  error: TError,
): void {
  const throttled = isThrottleError(error);
  for (const ref of refs) {
    results.set(entityRefKey(ref.entityType, ref.entityId), {
      error,
      throttled,
    });
  }
}

interface PendingEmbedding {
  ref: SearchableEntityRef;
  text: SearchableEntityText;
  embeddingHash: string;
}

interface EmbeddedPending {
  entry: PendingEmbedding;
  embedding: number[];
}

const dedupeRefs = (
  refs: ReadonlyArray<SearchableEntityRef>,
): SearchableEntityRef[] => {
  const uniqueRefs: SearchableEntityRef[] = [];
  const seenRefs = new Set<string>();
  for (const ref of refs) {
    const key = entityRefKey(ref.entityType, ref.entityId);
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    uniqueRefs.push(ref);
  }
  return uniqueRefs;
};

/**
 * Projection first, for every ref. Lexical projection runs for every
 * searchable type, financial entities included (see `search-document.ts`
 * `getSearchDocumentSources`); only `isEmbeddableEntity` types get a vector,
 * so that check comes after the projection refresh, not before it.
 */
async function projectEmbeddableRefs(
  db: Database,
  refs: ReadonlyArray<SearchableEntityRef>,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<SearchableEntityRef[]> {
  const projections = await refreshSearchDocuments(db, refs);
  const projectionByKey = new Map(
    projections.map((projection) => [
      entityRefKey(projection.entityType, projection.entityId),
      projection,
    ]),
  );
  const embeddable: SearchableEntityRef[] = [];
  for (const ref of refs) {
    const key = entityRefKey(ref.entityType, ref.entityId);
    const projection = projectionByKey.get(key);
    if (!projection || projection.status !== "upserted") {
      results.set(key, { outcome: "missing" });
      continue;
    }
    if (!isEmbeddableEntity(ref.entityType)) {
      results.set(key, { outcome: "notEmbeddable" });
      continue;
    }
    embeddable.push(ref);
  }
  return embeddable;
}

/** One batch text read, hashed locally against the config so the caller can
 * compare against one batch read of stored hashes. */
async function hashPendingTexts(
  db: Database,
  refs: ReadonlyArray<SearchableEntityRef>,
  config: SemanticEmbeddingConfig,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<PendingEmbedding[]> {
  const texts = await getSearchDocumentEmbeddingTexts(db, refs);
  const textByKey = new Map(
    texts.map((text) => [entityRefKey(text.entityType, text.entityId), text]),
  );
  const hashed: PendingEmbedding[] = [];
  for (const ref of refs) {
    const key = entityRefKey(ref.entityType, ref.entityId);
    const text = textByKey.get(key);
    if (!text) {
      results.set(key, { outcome: "missing" });
      continue;
    }
    const embeddingHash = await embeddingTextHash({
      entityType: text.entityType,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text: normalizeSearchText(text.embeddingText),
    });
    hashed.push({ ref, text, embeddingHash });
  }
  return hashed;
}

/** One batch stored-hash read; entries whose hash already matches are
 * reported "fresh" and dropped rather than paid for again. */
async function filterFreshEmbeddings(
  db: Database,
  hashed: ReadonlyArray<PendingEmbedding>,
  config: SemanticEmbeddingConfig,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<PendingEmbedding[]> {
  const storedHashes = await getStoredEmbeddingHashes(
    db,
    hashed.map((entry) => entry.ref),
    config,
  );
  const pending: PendingEmbedding[] = [];
  for (const entry of hashed) {
    const key = entityRefKey(entry.ref.entityType, entry.ref.entityId);
    if (storedHashes.get(key) === entry.embeddingHash) {
      results.set(key, { outcome: "fresh" });
      continue;
    }
    pending.push(entry);
  }
  return pending;
}

/**
 * One provider call for the whole pending set. `embedTexts` already sorts
 * its response by input index and throws on a count/dimension mismatch, so a
 * successful call zips 1:1 with `pending`. A thrown error fails every
 * pending ref in the batch — the queue retries those messages, which pays
 * the provider again, but there is nothing cheaper to fall back to.
 */
async function embedPending(
  db: Database,
  port: EmbeddingRefreshPort,
  pending: ReadonlyArray<PendingEmbedding>,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<EmbeddedPending[]> {
  let embeddings: number[][];
  try {
    embeddings = await port.embed(
      pending.map((entry) => entry.text.embeddingText),
      {
        operation: "entityEmbeddingRefresh",
        db,
        feature: ENTITY_EMBEDDING_FEATURE.feature,
      },
    );
  } catch (error) {
    setErrorForRefs(
      results,
      pending.map((entry) => entry.ref),
      error,
    );
    return [];
  }

  return pending.map((entry, index) => {
    const embedding = embeddings[index];
    if (!embedding) {
      // embedTexts validates the response count against pending.length.
      throw new Error(`Missing embedding at index ${index}`);
    }
    return { entry, embedding };
  });
}

/**
 * One Vectorize upsert for the whole batch, retried in place on a throttle
 * (see `upsertVectorsWithRetry`), then one Postgres bookkeeping statement for
 * the whole batch, conditional on each projection still being current
 * exactly like the single-ref path used to be. Refs whose write lost that
 * race are returned for the repair pass in `refreshEntityEmbeddings`, not
 * retried here.
 */
async function writeEmbeddingsBatch(
  db: Database,
  port: EmbeddingRefreshPort,
  config: SemanticEmbeddingConfig,
  embedded: ReadonlyArray<EmbeddedPending>,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<EmbeddedPending[]> {
  const vectors = embedded.map(({ entry, embedding }) => ({
    entityType: entry.ref.entityType,
    entityId: entry.ref.entityId,
    values: embedding,
  }));
  const upserted = await upsertVectorsWithRetry(port, vectors);
  if (!upserted.ok) {
    setErrorForRefs(
      results,
      embedded.map(({ entry }) => entry.ref),
      upserted.error,
    );
    return [];
  }

  let written: Set<string>;
  try {
    written = await upsertEntityEmbeddingsIfCurrent(
      db,
      embedded.map(({ entry }) => ({
        entityType: entry.ref.entityType,
        entityId: entry.ref.entityId,
        embeddingText: entry.text.embeddingText,
        embeddingHash: entry.embeddingHash,
        config,
      })),
    );
  } catch (error) {
    setErrorForRefs(
      results,
      embedded.map(({ entry }) => entry.ref),
      error,
    );
    return [];
  }

  const obsolete: EmbeddedPending[] = [];
  for (const item of embedded) {
    const key = entityRefKey(
      item.entry.ref.entityType,
      item.entry.ref.entityId,
    );
    if (written.has(key)) {
      results.set(key, { outcome: "written" });
    } else {
      obsolete.push(item);
    }
  }
  return obsolete;
}

/**
 * Repair pass for refs whose row write lost the race to a newer projection.
 * No freshness gate here: our vector upsert above may have just clobbered a
 * peer's fresher vector while Postgres already holds the peer's hash, so
 * "hash matches" must not short-circuit the vector repair. Refs whose text
 * is gone entirely have their vector deleted and are reported "obsolete"
 * directly; refs whose text survived are re-hashed for another embed
 * attempt.
 */
async function rehashForRepair(
  db: Database,
  port: EmbeddingRefreshPort,
  obsolete: ReadonlyArray<EmbeddedPending>,
  config: SemanticEmbeddingConfig,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<PendingEmbedding[]> {
  const refs = obsolete.map(({ entry }) => entry.ref);
  const texts = await getSearchDocumentEmbeddingTexts(db, refs);
  const textByKey = new Map(
    texts.map((text) => [entityRefKey(text.entityType, text.entityId), text]),
  );

  const gone: SearchableEntityRef[] = [];
  const rehashed: PendingEmbedding[] = [];
  for (const { entry } of obsolete) {
    const key = entityRefKey(entry.ref.entityType, entry.ref.entityId);
    const text = textByKey.get(key);
    if (!text) {
      gone.push(entry.ref);
      results.set(key, { outcome: "obsolete" });
      continue;
    }
    const embeddingHash = await embeddingTextHash({
      entityType: text.entityType,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text: normalizeSearchText(text.embeddingText),
    });
    rehashed.push({ ref: entry.ref, text, embeddingHash });
  }
  if (gone.length > 0) await port.vectorStore.deleteByIds(gone);
  return rehashed;
}

/**
 * Bring a wave of entities' vectors up to date with their current search
 * documents: one provider embed call and one Vectorize upsert per attempt,
 * instead of one pair of calls per entity. Both the AI Gateway and Vectorize
 * rate-limit per call, not per vector, so a multi-consumer backfill issuing
 * one call per entity trips both (`VECTOR_UPSERT_ERROR 40041 Too Many
 * Requests`, gateway `429`/2018).
 *
 * Idempotent by construction: the projection is refreshed first, the stored
 * hash is compared before the provider is paid, and the row write is
 * conditional on the projection still being current. A ref whose write loses
 * that race is retried — re-read, re-hash, re-embed, re-write — up to
 * `MAX_EMBED_ATTEMPTS` total attempts (see `rehashForRepair`).
 *
 * Every input ref, deduped by `entityRefKey`, gets exactly one entry in the
 * returned map.
 */
export async function refreshEntityEmbeddings(
  db: Database,
  refs: ReadonlyArray<SearchableEntityRef>,
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<Map<string, EmbeddingRefreshResult>> {
  const results = new Map<string, EmbeddingRefreshResult>();

  const uniqueRefs = dedupeRefs(refs);
  if (uniqueRefs.length === 0) return results;

  const embeddable = await projectEmbeddableRefs(db, uniqueRefs, results);
  if (embeddable.length === 0) return results;

  const config = port.config();
  const hashed = await hashPendingTexts(db, embeddable, config, results);
  if (hashed.length === 0) return results;

  let pending = await filterFreshEmbeddings(db, hashed, config, results);
  if (pending.length === 0) return results;

  if (!port.configured()) {
    for (const entry of pending) {
      results.set(entityRefKey(entry.ref.entityType, entry.ref.entityId), {
        outcome: "unconfigured",
      });
    }
    return results;
  }

  for (let attempt = 1; attempt <= MAX_EMBED_ATTEMPTS; attempt += 1) {
    const embedded = await embedPending(db, port, pending, results);
    if (embedded.length === 0) return results;

    const obsolete = await writeEmbeddingsBatch(
      db,
      port,
      config,
      embedded,
      results,
    );
    if (obsolete.length === 0) return results;

    const rehashed = await rehashForRepair(db, port, obsolete, config, results);
    if (rehashed.length === 0 || attempt === MAX_EMBED_ATTEMPTS) {
      for (const entry of rehashed) {
        results.set(entityRefKey(entry.ref.entityType, entry.ref.entityId), {
          outcome: "obsolete",
        });
      }
      return results;
    }
    pending = rehashed;
  }

  return results;
}
