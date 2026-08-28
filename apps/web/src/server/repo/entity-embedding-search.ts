import type { EmbeddingReadiness } from "@cubby/schemas/relatedness";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { entityEmbedding } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { getSearchDocumentEmbeddingText } from "~/server/repo/search-document";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { embeddingTextHash } from "~/server/semantic/hash";
import { normalizeSearchText } from "~/server/semantic/text";

export interface EntityEmbeddingCandidate {
  entityType: SearchableEntity;
  entityId: string;
  similarity: number;
}

/** Compare one entity's current document text to its configured stored vector. */
export async function getEntityEmbeddingReadiness(
  db: Database,
  ref: SearchableEntityRef,
  config: SemanticEmbeddingConfig,
): Promise<Exclude<EmbeddingReadiness, "unavailable">> {
  const [document, embedding] = await Promise.all([
    getSearchDocumentEmbeddingText(db, ref.entityType, ref.entityId),
    getDb(db).query.entityEmbedding.findFirst({
      where: and(
        eq(entityEmbedding.entityType, ref.entityType),
        eq(entityEmbedding.entityId, ref.entityId),
        eq(entityEmbedding.provider, config.provider),
        eq(entityEmbedding.model, config.model),
        eq(entityEmbedding.dimensions, config.dimensions),
        notDeleted(entityEmbedding),
      ),
      columns: { embeddingHash: true },
    }),
  ]);
  if (!document || !embedding) return "uncomputed";
  const expectedHash = await embeddingTextHash({
    entityType: ref.entityType,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    text: normalizeSearchText(document.embeddingText),
  });
  return embedding.embeddingHash === expectedHash ? "ready" : "stale";
}

/**
 * The query vector as ONE bound parameter, cast in SQL — not `sql.raw`, which
 * inlined ~30 KB of literal into the statement text so every search paid a
 * fresh parse and plan. Verified on production that binding it keeps the
 * `EntityEmbedding_embedding_hnsw_idx` index scan (1.17ms); the `dimensions`
 * literal beside it must still be raw, so the planner can prove that index's
 * partial predicate.
 */
const vectorLiteral = (embedding: number[]): SQL => {
  if (
    embedding.length === 0 ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Invalid embedding vector");
  }
  return sql`${`[${embedding.join(",")}]`}::vector`;
};

const semanticCandidateQueryErrorDetails = (
  error: unknown,
): Record<string, unknown> => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const pgError = cause as
    | {
        code?: unknown;
        severity?: unknown;
        detail?: unknown;
        hint?: unknown;
        routine?: unknown;
      }
    | null
    | undefined;

  return {
    errorName: error instanceof Error ? error.name : typeof error,
    pgCode: pgError?.code,
    severity: pgError?.severity,
    detail: pgError?.detail,
    hint: pgError?.hint,
    routine: pgError?.routine,
  };
};

export async function findSemanticEntityCandidates(
  db: Database,
  queryEmbedding: number[],
  config: SemanticEmbeddingConfig,
  opts: { entityTypes?: SearchableEntity[]; limit: number },
): Promise<EntityEmbeddingCandidate[]> {
  let rows: Array<{
    entityType: SearchableEntity;
    entityId: string;
    similarity: string | number;
  }>;
  try {
    const typeFilter =
      opts.entityTypes && opts.entityTypes.length > 0
        ? sql`AND ee."entityType" IN (${sql.join(
            opts.entityTypes.map((entityType) => sql`${entityType}`),
            sql`, `,
          )})`
        : sql``;
    const vector = vectorLiteral(queryEmbedding);
    // The `embedding::vector(N)` cast must match the expression in
    // EntityEmbedding_embedding_hnsw_idx exactly, or the planner falls back
    // to a seq scan (the raw column is untyped `vector`, which pgvector
    // can't index directly). config.dimensions is a number from
    // AI_MODEL_REGISTRY, safe to inline raw.
    const castEmbedding = sql.raw(
      `ee."embedding"::vector(${config.dimensions})`,
    );
    // Inline the dimensions filter as a literal (config.dimensions is a
    // trusted registry number) so the planner can prove the partial-index
    // predicate `dimensions = 1536` and use EntityEmbedding_embedding_hnsw_idx.
    const dimensionsFilter = sql.raw(`ee."dimensions" = ${config.dimensions}`);
    const result = await getDb(db).execute<{
      entityType: SearchableEntity;
      entityId: string;
      similarity: string | number;
    }>(sql`
      SELECT
        ee."entityType" AS "entityType",
        ee."entityId"::text AS "entityId",
        1 - (${castEmbedding} <=> ${vector}) AS "similarity"
      FROM "EntityEmbedding" ee
      WHERE ee."deletedAt" IS NULL
        AND ee."provider" = ${config.provider}
        AND ee."model" = ${config.model}
        AND ${dimensionsFilter}
        ${typeFilter}
      ORDER BY ${castEmbedding} <=> ${vector}
      LIMIT ${opts.limit}
    `);
    rows = result.rows as Array<{
      entityType: SearchableEntity;
      entityId: string;
      similarity: string | number;
    }>;
  } catch (error) {
    console.error("semantic.entity-candidates.failed", {
      ...semanticCandidateQueryErrorDetails(error),
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      entityTypes: opts.entityTypes ?? null,
      limit: opts.limit,
      embeddingDimensions: queryEmbedding.length,
    });
    throw new Error(
      "Semantic search failed while reading entity embeddings. Check pgvector setup and embedding dimensions.",
      { cause: error },
    );
  }
  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    similarity:
      typeof row.similarity === "number"
        ? row.similarity
        : Number.parseFloat(row.similarity),
  }));
}

/**
 * Entity-to-entity nearest neighbours: read the seed entity's own stored
 * embedding back out, then reuse it as the query vector.
 *
 * Two queries on purpose. The seed lookup rides the
 * `EntityEmbedding_entity_model_key` unique index, and the neighbour search
 * goes through {@link findSemanticEntityCandidates} **verbatim** so the
 * `embedding::vector(N)` cast and the literal `dimensions = N` predicate stay
 * syntactically identical to `EntityEmbedding_embedding_hnsw_idx`. A
 * hand-written self-join here would silently lose the index and seq-scan every
 * embedding in the table.
 *
 * Returns `[]` when the seed has no embedding row yet (never embedded, or
 * embedded under a different model config).
 */
export async function findSimilarEntities(
  db: Database,
  seed: SearchableEntityRef,
  config: SemanticEmbeddingConfig,
  opts: { targetType: SearchableEntity; limit: number },
): Promise<EntityEmbeddingCandidate[]> {
  const seedRow = await getDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityType, seed.entityType),
      eq(entityEmbedding.entityId, seed.entityId),
      eq(entityEmbedding.provider, config.provider),
      eq(entityEmbedding.model, config.model),
      eq(entityEmbedding.dimensions, config.dimensions),
      notDeleted(entityEmbedding),
    ),
    columns: { embedding: true },
  });
  if (!seedRow) return [];

  // +1 so the seed itself (always its own nearest neighbour when source and
  // target types match) can be dropped without shrinking the result set.
  const candidates = await findSemanticEntityCandidates(
    db,
    seedRow.embedding,
    config,
    { entityTypes: [opts.targetType], limit: opts.limit + 1 },
  );

  return candidates
    .filter(
      (candidate) =>
        !(
          candidate.entityType === seed.entityType &&
          candidate.entityId === seed.entityId
        ),
    )
    .slice(0, opts.limit);
}
