import { entityRefKey } from "@cubby/schemas/entity";
import type { EmbeddingReadiness } from "@cubby/schemas/relatedness";
import {
  searchableEntities,
  type SearchableEntity,
  type SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { chunk } from "es-toolkit";
import { z } from "zod";

import { normalizeSearchText } from "~/lib/search-normalization";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import {
  entityEmbedding,
  entityIdentity,
  searchDocument,
} from "~/server/db/schema";
import { embeddingTextHash } from "~/server/generic/embedding/repo/semantic/hash";
import type { SemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import type {
  PhysicalVectorMatch,
  VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import {
  searchCoverageIncomplete,
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
const artifactIdSchema = z.uuid();

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
    const parsed = artifactIdSchema.safeParse(id);
    return parsed.success ? [parsed.data] : [];
  });
  const current = ids.length
    ? await currentArtifacts(db, config, inArray(entityEmbedding.id, ids))
    : [];
  const byId = new Map(current.map((row) => [row.id, row]));
  // Per candidate kind: unrelated queued search work cannot withhold completeness.
  const incomplete = await searchCoverageIncomplete(db, config, kinds);
  return scanValidatedMatches({ raw, byId, kinds, limit, seed, incomplete });
}

function scanValidatedMatches({
  raw,
  byId,
  kinds,
  limit,
  seed,
  incomplete,
}: {
  raw: readonly PhysicalVectorMatch[];
  byId: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof selectedArtifacts>>[number] | null
  >;
  kinds: readonly SearchableEntity[];
  limit: number;
  seed?: SearchableEntityRef;
  incomplete: boolean;
}): SemanticCandidateScan {
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
  return {
    candidates: candidates.slice(0, limit),
    complete:
      !incomplete &&
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
  const results = await findSimilarEntitiesPage(
    db,
    vectorStore,
    [seed],
    options,
  );
  const result = results.get(entityRefKey(seed.entityKind, seed.entityId));
  if (result?.status === "rejected") throw result.reason;
  return result?.value ?? { candidates: [], complete: false };
}

/** Share seed and hit validation within one page without reconstructing the corpus. */
export async function findSimilarEntitiesPage(
  db: Database,
  vectorStore: VectorStorePort,
  seeds: readonly SearchableEntityRef[],
  options: {
    targetType: SearchableEntity;
    limit: number;
    config: SemanticEmbeddingConfig;
  },
): Promise<Map<string, PromiseSettledResult<SemanticCandidateScan>>> {
  const results = new Map<
    string,
    PromiseSettledResult<SemanticCandidateScan>
  >();
  if (!seeds.length) return results;
  const unique = [
    ...new Map(
      seeds.map((seed) => [entityRefKey(seed.entityKind, seed.entityId), seed]),
    ).values(),
  ];
  const selected: Awaited<ReturnType<typeof currentArtifacts>> = [];
  for (const batch of chunk(unique, CANDIDATE_BUDGET))
    selected.push(
      ...(await currentArtifacts(
        db,
        options.config,
        or(
          ...batch.map((seed) =>
            and(
              eq(entityEmbedding.entityKind, seed.entityKind),
              eq(entityEmbedding.entityId, seed.entityId),
            ),
          ),
        ),
      )),
    );
  const byRef = new Map(
    selected.map((row) => [entityRefKey(row.entityKind, row.entityId), row]),
  );
  const byId = new Map<string, (typeof selected)[number] | null>(
    selected.map((row) => [row.id, row]),
  );
  const observed = new Map(
    (selected.length
      ? await vectorStore.getByIds(selected.map((row) => row.id))
      : []
    ).map((row) => [row.id, row]),
  );
  const queried = new Set<string>();
  for (const wave of chunk(unique, 4)) {
    const scans = await Promise.allSettled(
      wave.map(async (seed) => {
        const artifact = byRef.get(
          entityRefKey(seed.entityKind, seed.entityId),
        );
        const vector = artifact ? observed.get(artifact.id) : undefined;
        if (
          !artifact ||
          !vector ||
          vector.values.length !== options.config.dimensions ||
          (await vectorPayloadHash(vector.values)) !== artifact.vectorHash
        )
          return null;
        return {
          seed,
          raw: await vectorStore.queryById(artifact.id, {
            entityKinds: [options.targetType],
            topK: CANDIDATE_BUDGET,
          }),
        };
      }),
    );
    const pending: { seed: SearchableEntityRef; raw: PhysicalVectorMatch[] }[] =
      [];
    for (const [index, scan] of scans.entries()) {
      const seed = wave[index]!;
      const key = entityRefKey(seed.entityKind, seed.entityId);
      if (scan.status === "rejected") results.set(key, scan);
      else if (scan.value) pending.push(scan.value);
      else
        results.set(key, {
          status: "fulfilled",
          value: { candidates: [], complete: false },
        });
    }
    const ids = [
      ...new Set(
        pending.flatMap(({ raw }) =>
          raw.flatMap(({ id }) => {
            const parsed = artifactIdSchema.safeParse(id);
            return parsed.success && !byId.has(parsed.data)
              ? [parsed.data]
              : [];
          }),
        ),
      ),
    ];
    // Raw matches are compact; canonical bodies stay within the existing hit bound.
    for (const batch of chunk(ids, CANDIDATE_BUDGET)) {
      const current = await currentArtifacts(
        db,
        options.config,
        inArray(entityEmbedding.id, batch),
      );
      for (const id of batch) byId.set(id, null);
      for (const row of current) byId.set(row.id, row);
    }
    for (const { seed, raw } of pending) {
      const key = entityRefKey(seed.entityKind, seed.entityId);
      queried.add(key);
      results.set(key, {
        status: "fulfilled",
        value: scanValidatedMatches({
          raw,
          byId,
          kinds: [options.targetType],
          limit: options.limit,
          seed,
          incomplete: false,
        }),
      });
    }
  }
  // Check after live validation, so newly owed work cannot gain completeness.
  if (
    queried.size &&
    (await searchCoverageIncomplete(db, options.config, [options.targetType]))
  )
    for (const key of queried) {
      const result = results.get(key);
      if (result?.status === "fulfilled") result.value.complete = false;
    }
  return results;
}
