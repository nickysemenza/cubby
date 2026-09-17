import {
  isEmbeddableEntity,
  type SearchableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getStoredEmbeddingHash,
  getStoredEmbeddingHashes,
  type SearchableEntityText,
  upsertEntityEmbeddingIfCurrent,
} from "~/server/repo/entity-embedding-refresh";
import {
  getSearchDocumentEmbeddingText,
  getSearchDocumentEmbeddingTexts,
  refreshSearchDocument,
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

export type EmbeddingRefreshOutcome =
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
 * the first covers the ordinary race (this refresh's own vector upsert
 * clobbering a concurrent writer's fresher one, see below); it is not meant
 * to converge an entity under continuous rewrite.
 */
const MAX_EMBED_ATTEMPTS = 3;

/**
 * Bring one entity's vector up to date with its current search document.
 *
 * Idempotent by construction: the projection is refreshed first, the stored
 * hash is compared before the provider is paid, and the write is conditional
 * on the projection still being current. Duplicate or out-of-order deliveries
 * therefore cost at most one cheap read.
 */
export async function refreshEntityEmbedding(
  db: Database,
  ref: { entityType: SearchableEntity; entityId: string },
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<EmbeddingRefreshOutcome> {
  const refreshed = await refreshSearchDocument(
    db,
    ref.entityType,
    ref.entityId,
  );
  if (refreshed.status !== "upserted") return "missing";

  // The lexical SearchDocument projection above runs for every searchable
  // type, financial entities included (see `search-document.ts`
  // `getSearchDocumentSources`); only `isEmbeddableEntity` types get a
  // vector, so this check comes after the projection refresh, not before it.
  if (!isEmbeddableEntity(ref.entityType)) return "notEmbeddable";

  const config = port.config();
  let text = await getSearchDocumentEmbeddingText(
    db,
    ref.entityType,
    ref.entityId,
  );
  if (!text) return "missing";

  const embeddingHash = await embeddingTextHash({
    entityType: text.entityType,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    text: normalizeSearchText(text.embeddingText),
  });
  const stored = await getStoredEmbeddingHash(db, {
    entityType: text.entityType,
    entityId: text.entityId,
    config,
  });
  if (stored === embeddingHash) return "fresh";
  if (!port.configured()) return "unconfigured";

  // Only the first attempt reuses the hash/text pair the gate above already
  // checked; every retry below re-derives both from the CURRENT projection —
  // no freshness short-circuit — because the point of retrying is to land a
  // vector for whatever text is live now, not to discover it already matches
  // and skip repairing the vector store (see the "obsolete" branch comment).
  let currentHash = embeddingHash;
  for (let attempt = 0; attempt < MAX_EMBED_ATTEMPTS; attempt += 1) {
    const [embedding] = await port.embed([text.embeddingText], {
      operation: "entityEmbeddingRefresh",
      db,
      feature: "entity-embedding",
      entity: { entityType: text.entityType, entityId: text.entityId },
    });
    if (!embedding) return "obsolete";

    // The vector store is written BEFORE the Postgres bookkeeping row: a
    // crash between the two calls leaves the entity "missing" (no
    // EntityEmbedding row at all), which a later refresh repairs, rather than
    // "ready" with a hash row pointing at a vector that was never stored.
    await port.vectorStore.upsert([
      {
        entityType: text.entityType,
        entityId: text.entityId,
        values: embedding,
      },
    ]);
    const outcome = await upsertEntityEmbeddingIfCurrent(db, {
      ...text,
      embeddingHash: currentHash,
      config,
    });
    if (outcome === "written") return "written";

    // "obsolete": the projection changed between embedding and persistence,
    // so the row above was not written for the text we just embedded. Our
    // vector-store upsert already landed, though, and may have clobbered a
    // concurrent writer's fresher vector with our now-stale one. Re-reading
    // the CURRENT text, re-embedding it, and looping repairs that clobber
    // ourselves (bounded by `MAX_EMBED_ATTEMPTS`) instead of leaving the
    // vector store permanently behind Postgres until some unrelated write
    // happens to touch this entity again.
    const current = await getSearchDocumentEmbeddingText(
      db,
      ref.entityType,
      ref.entityId,
    );
    if (!current) {
      await port.vectorStore.deleteByIds([
        { entityType: ref.entityType, entityId: ref.entityId },
      ]);
      return "obsolete";
    }
    text = current;
    currentHash = await embeddingTextHash({
      entityType: text.entityType,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text: normalizeSearchText(text.embeddingText),
    });
  }
  return "obsolete";
}

export type EmbeddingRefreshResult =
  | { outcome: EmbeddingRefreshOutcome }
  | { error: unknown };

/** The map key a batch refresh uses to report one result per input ref. */
export const embeddingRefreshKey = (ref: SearchableEntityRef): string =>
  `${ref.entityType}:${ref.entityId}`;

/**
 * Extracts a message from either a real `Error` or a message-bearing value
 * thrown across a non-JS boundary (a Workers binding rejection, an RPC
 * error), defaulting to "" for anything else — a boundary parse rather than
 * an `instanceof`/`typeof` narrowing chain over the caught value.
 */
const errorMessageSchema = z
  .union([
    z.instanceof(Error).transform((error) => error.message),
    z.object({ message: z.string() }).transform(({ message }) => message),
  ])
  .catch("");

/**
 * Vectorize's mutation rate limit (`VECTOR_UPSERT_ERROR 40041`) and a generic
 * HTTP 429 both surface as a throttle that should be retried in place, not
 * treated the same as a malformed request or a genuine outage.
 */
function isRetryableVectorUpsertError(error: unknown): boolean {
  const message = errorMessageSchema.parse(error);
  return (
    message.includes("40041") ||
    message.includes("Too Many Requests") ||
    message.includes("429")
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
  for (
    let attempt = 0;
    attempt <= VECTOR_UPSERT_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      await port.vectorStore.upsert(vectors);
      return { ok: true };
    } catch (error) {
      const delayMs = VECTOR_UPSERT_RETRY_DELAYS_MS[attempt];
      if (!isRetryableVectorUpsertError(error) || delayMs === undefined) {
        return { ok: false, error };
      }
      await sleep(delayMs + Math.random() * 250);
    }
  }
  // Unreachable: the loop above always returns before the delay list is
  // exhausted (the last iteration's `delayMs` is `undefined`).
  return { ok: false, error: new Error("Vectorize upsert retries exhausted") };
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
    const key = embeddingRefreshKey(ref);
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    uniqueRefs.push(ref);
  }
  return uniqueRefs;
};

/**
 * Projection first, for every ref, exactly like the single-entity path.
 * Lexical projection runs for every searchable type, financial entities
 * included; only `isEmbeddableEntity` types get a vector, so that check
 * comes after the projection refresh, not before it (see
 * `refreshEntityEmbedding` above).
 */
async function projectEmbeddableRefs(
  db: Database,
  refs: ReadonlyArray<SearchableEntityRef>,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<SearchableEntityRef[]> {
  const projections = await refreshSearchDocuments(db, refs);
  const projectionByKey = new Map(
    projections.map((projection) => [
      embeddingRefreshKey(projection),
      projection,
    ]),
  );
  const embeddable: SearchableEntityRef[] = [];
  for (const ref of refs) {
    const key = embeddingRefreshKey(ref);
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
    texts.map((text) => [embeddingRefreshKey(text), text]),
  );
  const hashed: PendingEmbedding[] = [];
  for (const ref of refs) {
    const key = embeddingRefreshKey(ref);
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
    const key = embeddingRefreshKey(entry.ref);
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
      { operation: "entityEmbeddingRefresh", db, feature: "entity-embedding" },
    );
  } catch (error) {
    for (const entry of pending) {
      results.set(embeddingRefreshKey(entry.ref), { error });
    }
    return [];
  }

  const embedded: EmbeddedPending[] = [];
  for (const [index, entry] of pending.entries()) {
    const embedding = embeddings[index];
    if (!embedding) {
      // Guards the type only: `embedTexts` already validated the response
      // count against `pending.length`, so this is unreachable in practice.
      results.set(embeddingRefreshKey(entry.ref), {
        error: new Error(`Missing embedding at index ${index}`),
      });
      continue;
    }
    embedded.push({ entry, embedding });
  }
  return embedded;
}

/**
 * One Vectorize upsert for the whole batch, retried in place on a throttle
 * (see `upsertVectorsWithRetry`), then the per-ref Postgres bookkeeping
 * write, conditional on the projection still being current exactly like the
 * single-entity path. An "obsolete" write delegates to
 * `refreshEntityEmbedding` rather than duplicating its repair loop.
 */
async function writeEmbeddings(
  db: Database,
  port: EmbeddingRefreshPort,
  config: SemanticEmbeddingConfig,
  embedded: ReadonlyArray<EmbeddedPending>,
  results: Map<string, EmbeddingRefreshResult>,
): Promise<void> {
  const vectors = embedded.map(({ entry, embedding }) => ({
    entityType: entry.ref.entityType,
    entityId: entry.ref.entityId,
    values: embedding,
  }));
  const upserted = await upsertVectorsWithRetry(port, vectors);
  if (!upserted.ok) {
    for (const { entry } of embedded) {
      results.set(embeddingRefreshKey(entry.ref), { error: upserted.error });
    }
    return;
  }

  for (const { entry } of embedded) {
    const key = embeddingRefreshKey(entry.ref);
    try {
      const outcome = await upsertEntityEmbeddingIfCurrent(db, {
        ...entry.text,
        embeddingHash: entry.embeddingHash,
        config,
      });
      if (outcome === "written") {
        results.set(key, { outcome: "written" });
        continue;
      }
      const repaired = await refreshEntityEmbedding(db, entry.ref, port);
      results.set(key, { outcome: repaired });
    } catch (error) {
      results.set(key, { error });
    }
  }
}

/**
 * Batch form of {@link refreshEntityEmbedding}: one provider embed call and
 * one Vectorize upsert for a whole queue batch, instead of one pair of calls
 * per entity. Both the AI Gateway and Vectorize rate-limit per call, not per
 * vector, so a multi-consumer backfill issuing one call per entity trips
 * both (`VECTOR_UPSERT_ERROR 40041 Too Many Requests`, gateway `429`/2018).
 *
 * At batch size 1 this is equivalent to the single-entity path: same
 * projection refresh, same freshness gate, same pay-then-write ordering.
 * Every input ref, deduped by `embeddingRefreshKey`, gets exactly one entry
 * in the returned map.
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

  const pending = await filterFreshEmbeddings(db, hashed, config, results);
  if (pending.length === 0) return results;

  if (!port.configured()) {
    for (const entry of pending) {
      results.set(embeddingRefreshKey(entry.ref), { outcome: "unconfigured" });
    }
    return results;
  }

  const embedded = await embedPending(db, port, pending, results);
  if (embedded.length === 0) return results;

  await writeEmbeddings(db, port, config, embedded, results);
  return results;
}
