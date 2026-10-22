import { entityRefKey } from "@cubby/schemas/entity";
import type { EmbeddingReadiness } from "@cubby/schemas/relatedness";
import {
  searchableEntities,
  type SearchableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import {
  entityEmbedding,
  entityIdentity,
  searchDocument,
} from "~/server/db/schema";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import { normalizeSearchText } from "~/server/generic/embedding/repo/semantic/text";
import type { SemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import type {
  PhysicalVectorMatch,
  VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import {
  hasUnembeddedSearchDocuments,
  prepareSearchDocuments,
} from "~/server/generic/search/repo/search-document";

import { vectorPayloadHash } from "./embedding-artifact";

interface EntityEmbeddingCandidate extends SearchableEntityRef {
  similarity: number;
}
/** Complete describes eligible corpus and budget, never exhaustive ANN recall. */
export interface SemanticCandidateScan {
  candidates: EntityEmbeddingCandidate[];
  complete: boolean;
}
export class SemanticCoverageIncomplete extends Error {}
const CANDIDATE_BUDGET = 100;

async function selectedArtifacts(
  db: Database,
  config: SemanticEmbeddingConfig,
  where: SQL | undefined,
) {
  if (!where) return [];
  return getDb(db)
    .select({
      id: entityEmbedding.id,
      entityKind: entityEmbedding.entityKind,
      entityId: entityEmbedding.entityId,
      hash: entityEmbedding.artifactHash,
      vectorHash: entityEmbedding.vectorHash,
      text: searchDocument.semanticText,
    })
    .from(entityEmbedding)
    .innerJoin(
      searchDocument,
      and(
        eq(searchDocument.entityKind, entityEmbedding.entityKind),
        eq(searchDocument.entityId, entityEmbedding.entityId),
      ),
    )
    .innerJoin(
      entityIdentity,
      and(
        eq(entityIdentity.id, entityEmbedding.entityId),
        eq(entityIdentity.kind, entityEmbedding.entityKind),
      ),
    )
    .where(
      and(
        where,
        eq(entityEmbedding.artifactState, "selected"),
        isNull(entityEmbedding.deletedAt),
        isNotNull(entityEmbedding.observedAt),
        isNotNull(entityEmbedding.indexedAt),
        isNotNull(entityEmbedding.artifactHash),
        isNotNull(entityEmbedding.vectorHash),
        eq(entityEmbedding.provider, config.provider),
        eq(entityEmbedding.model, config.model),
        eq(entityEmbedding.dimensions, config.dimensions),
        isNull(searchDocument.deletedAt),
        isNull(entityIdentity.deletedAt),
      ),
    );
}

async function currentArtifacts(
  db: Database,
  config: SemanticEmbeddingConfig,
  where: SQL | undefined,
) {
  if (!where) return [];
  const rows = await selectedArtifacts(db, config, where);
  return validateCurrentArtifacts(db, config, rows);
}

async function validateCurrentArtifacts(
  db: Database,
  config: SemanticEmbeddingConfig,
  rows: Awaited<ReturnType<typeof selectedArtifacts>>,
) {
  if (rows.length === 0) return [];
  const prepared = await prepareSearchDocuments(db, rows);
  const liveText = new Map(
    prepared.entries.map(({ source, body }) => [
      entityRefKey(source.entityKind, source.entityId),
      body,
    ]),
  );
  const current = [];
  for (const row of rows) {
    const text = liveText.get(entityRefKey(row.entityKind, row.entityId));
    if (text === undefined) continue;
    const hash = await embeddingTextHash({
      entityKind: row.entityKind,
      ...config,
      text: normalizeSearchText(text),
    });
    if (row.hash === hash) current.push(row);
  }
  return current;
}

async function validatedScan(
  db: Database,
  raw: PhysicalVectorMatch[],
  kinds: readonly SearchableEntity[],
  limit: number,
  config: SemanticEmbeddingConfig,
  seed?: SearchableEntityRef,
): Promise<SemanticCandidateScan> {
  const ids = raw.flatMap(({ id }) => {
    const parsed = z.uuid().safeParse(id);
    return parsed.success ? [parsed.data] : [];
  });
  const current = ids.length
    ? await currentArtifacts(db, config, inArray(entityEmbedding.id, ids))
    : [];
  const byId = new Map(current.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const candidates: EntityEmbeddingCandidate[] = [];
  for (const match of raw) {
    const row = byId.get(match.id);
    if (
      !row ||
      !kinds.includes(row.entityKind) ||
      (seed &&
        row.entityKind === seed.entityKind &&
        row.entityId === seed.entityId)
    )
      continue;
    const key = entityRefKey(row.entityKind, row.entityId);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      entityKind: row.entityKind,
      entityId: row.entityId,
      similarity: match.similarity,
    });
  }
  const [pending] = await getDb(db)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        inArray(job.key, ["refresh:search", "refresh:embeddings"]),
        inArray(job.state, [
          "queued",
          "running",
          "retry_wait",
          "paused",
          "failed",
        ]),
      ),
    )
    .limit(1);
  const missing = await hasUnembeddedSearchDocuments(db, config, kinds);
  return {
    candidates: candidates.slice(0, limit),
    complete:
      !pending &&
      !missing &&
      !(raw.length === CANDIDATE_BUDGET && candidates.length < limit),
  };
}

/** Seed readiness is local; corpus gaps withhold completeness, not valid matches. */
export async function getEntityEmbeddingReadiness(
  db: Database,
  ref: SearchableEntityRef,
  config: SemanticEmbeddingConfig,
): Promise<Exclude<EmbeddingReadiness, "unavailable">> {
  const rows = await selectedArtifacts(
    db,
    config,
    and(
      eq(entityEmbedding.entityKind, ref.entityKind),
      eq(entityEmbedding.entityId, ref.entityId),
    ),
  );
  if (rows.length === 0) return "uncomputed";
  return (await validateCurrentArtifacts(db, config, rows)).length
    ? "ready"
    : "stale";
}

/** One fixed-budget ANN request; all physical matches pass the same database validation. */
export async function findSemanticEntityCandidates(
  db: Database,
  vectorStore: VectorStorePort,
  query: number[],
  options: {
    entityKinds?: SearchableEntity[];
    limit: number;
    config: SemanticEmbeddingConfig;
  },
): Promise<SemanticCandidateScan> {
  const kinds = options.entityKinds?.length
    ? options.entityKinds
    : [...searchableEntities];
  const raw = await vectorStore.query(query, {
    entityKinds: kinds,
    topK: CANDIDATE_BUDGET,
  });
  return validatedScan(db, raw, kinds, options.limit, options.config);
}

/** Resolve the selected physical seed, then validate both its payload and every result. */
export async function findSimilarEntities(
  db: Database,
  vectorStore: VectorStorePort,
  seed: SearchableEntityRef,
  options: {
    targetType: SearchableEntity;
    limit: number;
    config: SemanticEmbeddingConfig;
  },
): Promise<SemanticCandidateScan> {
  const [selected] = await currentArtifacts(
    db,
    options.config,
    and(
      eq(entityEmbedding.entityKind, seed.entityKind),
      eq(entityEmbedding.entityId, seed.entityId),
    ),
  );
  if (!selected) return { candidates: [], complete: false };
  const [observed] = await vectorStore.getByIds([selected.id]);
  if (
    !observed ||
    observed.values.length !== options.config.dimensions ||
    (await vectorPayloadHash(observed.values)) !== selected.vectorHash
  )
    return { candidates: [], complete: false };
  const raw = await vectorStore.queryById(selected.id, {
    entityKinds: [options.targetType],
    topK: CANDIDATE_BUDGET,
  });
  return validatedScan(
    db,
    raw,
    [options.targetType],
    options.limit,
    options.config,
    seed,
  );
}
