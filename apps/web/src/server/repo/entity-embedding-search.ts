import type { SearchableEntity } from "@cubby/schemas/search";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";

export interface EntityEmbeddingCandidate {
  entityType: SearchableEntity;
  entityId: string;
  similarity: number;
}

const vectorLiteral = (embedding: number[]): ReturnType<typeof sql.raw> => {
  if (
    embedding.length === 0 ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Invalid embedding vector");
  }
  return sql.raw(`'[${embedding.join(",")}]'::vector`);
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
