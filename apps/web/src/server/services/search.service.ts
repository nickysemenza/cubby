import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  type RelatedSearchOut,
  type SearchableEntity,
  type SearchHit,
  type SearchQueryInput,
  searchHitSchema,
  searchableEntities,
} from "@cubby/schemas/search";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { findSemanticEntityCandidates } from "~/server/repo/entity-embedding-search";
import { loadLocationAncestors } from "~/server/repo/location/tree";
import { executeSearchDocumentSql } from "~/server/repo/search-document";
import { buildPrefixTsQuery, searchTerms } from "~/server/repo/search-lexical";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { normalizeSearchText } from "~/server/semantic/text";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/semantic/vector-store";
import { TraceNames, withTrace } from "~/server/tracing";

const candidateSchema = searchHitSchema
  .omit({ imageUrl: true, locationPath: true })
  .extend({
    entityId: z.uuid(),
  });
export type InternalSearchCandidate = z.output<typeof candidateSchema>;
export type InternalSearchHit = SearchHit & { entityId: string };
type ServiceSearchQueryInput = Omit<SearchQueryInput, "limit"> & {
  limit?: number;
};

export interface RelatedSearchPort {
  readonly configured: () => boolean;
  readonly embed: typeof embedQuery;
  readonly vectorStore: VectorStorePort;
}

export type InternalRelatedSearchCandidates =
  | { status: "ready"; results: InternalSearchCandidate[] }
  | { status: "unavailable"; results: [] };

const productionRelatedSearchPort: RelatedSearchPort = {
  configured: semanticEmbeddingsConfigured,
  embed: embedQuery,
  vectorStore: productionVectorStore,
};

export { buildPrefixTsQuery, searchTerms } from "~/server/repo/search-lexical";

const scopes = (entityTypes?: SearchableEntity[]) =>
  entityTypes?.length ? entityTypes : [...searchableEntities];

const textArray = (values: string[]): SQL =>
  values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;

async function hydrateThumbnails(
  db: Database,
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<Map<string, string | null>> {
  const images = await resolveEntityDisplayImages(db, refs);
  return new Map(
    refs.map((ref) => [
      entityRefKey(ref.entityType, ref.entityId),
      images.get(entityRefKey(ref.entityType, ref.entityId))?.url ?? null,
    ]),
  );
}

const withThumbnails = async (
  db: Database,
  candidates: InternalSearchCandidate[],
): Promise<SearchHit[]> => {
  const images = await hydrateThumbnails(db, candidates);
  const paths = await loadLocationAncestors(
    db,
    candidates
      .filter((candidate) => candidate.entityType === "location")
      .map((candidate) => parseEntityId("location", candidate.entityId)),
  );
  return candidates.map(({ entityId, ...candidate }) => ({
    ...candidate,
    imageUrl: images.get(entityRefKey(candidate.entityType, entityId)) ?? null,
    ...(candidate.entityType === "location" && {
      locationPath:
        paths
          .get(parseEntityId("location", entityId))
          ?.map(({ id, name }) => ({ id, name })) ?? [],
    }),
  }));
};

/** One indexed lexical candidate query; rank before applying the caller limit. */
export async function findLexicalSearchCandidates(
  db: Database,
  input: ServiceSearchQueryInput,
  maxLimit = 200,
): Promise<InternalSearchCandidate[]> {
  const normalized = normalizeSearchText(input.query);
  const tsQuery = buildPrefixTsQuery(input.query);
  if (!normalized || !tsQuery) return [];
  const limit = Math.min(Math.max(input.limit ?? 5, 1), maxLimit);
  const entityTypes = scopes(input.entityTypes);
  const matchTerms = textArray(searchTerms(input.query));
  const rows = await withTrace(
    TraceNames.service("search", "lexicalCandidates"),
    async (span) => {
      const candidates = await executeSearchDocumentSql(
        db,
        candidateSchema,
        sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsQuery}) AS query),
    fuzzy AS (
      SELECT sd.id
      FROM "SearchDocument" sd
      WHERE sd."deletedAt" IS NULL
        AND char_length(${normalized}) >= 3
        AND sd."entityType" IN (${sql.join(
          entityTypes.map((type) => sql`${type}`),
          sql`, `,
        )})
        AND sd."normalizedText" % ${normalized}
      ORDER BY sd."normalizedText" <-> ${normalized}
      LIMIT ${Math.min(limit * 4, 200)}
    ),
    candidates AS (
      SELECT sd.id
      FROM "SearchDocument" sd CROSS JOIN q
      WHERE sd."deletedAt" IS NULL
        AND sd."entityType" IN (${sql.join(
          entityTypes.map((type) => sql`${type}`),
          sql`, `,
        )})
        AND (
          lower(sd."shortcode") = ${normalized}
          OR lower(sd.title) = ${normalized}
          OR lower(sd.title) LIKE ${`${normalized}%`}
          OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) = ${normalized} OR lower(term) LIKE ${`${normalized}%`})
          OR sd."searchVector" @@ q.query
        )
      UNION
      SELECT id FROM fuzzy
    )
    SELECT sd."entityId"::text AS "entityId", sd."shortcode" AS id, sd."entityType", sd.title, sd.subtitle, sd."typeHint",
      CASE
        WHEN lower(sd."shortcode") = ${normalized} OR lower(sd.title) = ${normalized}
          OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) = ${normalized}) THEN 'exact'
        WHEN lower(sd.title) LIKE ${`${normalized}%`} OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) LIKE ${`${normalized}%`}) THEN 'prefix'
        WHEN sd."searchVector" @@ q.query THEN 'text'
        ELSE 'fuzzy'
      END AS "matchKind",
      CASE
        WHEN lower(sd."shortcode") = ${normalized} THEN 'shortcode'
        WHEN lower(sd.title) = ${normalized} OR lower(sd.title) LIKE ${`${normalized}%`} THEN 'title'
        WHEN EXISTS (SELECT 1 FROM unnest(sd.aliases) term WHERE lower(term) = ${normalized} OR lower(term) LIKE ${`${normalized}%`}) THEN 'alias'
        WHEN EXISTS (SELECT 1 FROM unnest(sd.keywords) term WHERE lower(term) = ${normalized} OR lower(term) LIKE ${`${normalized}%`}) THEN 'keyword'
        WHEN to_tsvector('simple', sd.title) @@ q.query THEN 'title'
        WHEN to_tsvector('simple', array_to_string(sd.aliases, ' ')) @@ q.query THEN 'alias'
        WHEN to_tsvector('simple', array_to_string(sd.keywords, ' ')) @@ q.query THEN 'keyword'
        WHEN sd."searchVector" @@ q.query THEN 'body'
        ELSE 'title'
      END AS "matchField",
      CASE
        WHEN lower(sd."shortcode") = ${normalized} THEN 'Exact shortcode match'
        WHEN lower(sd.title) = ${normalized} THEN 'Exact title match'
        WHEN EXISTS (SELECT 1 FROM unnest(sd.aliases) term WHERE lower(term) = ${normalized}) THEN 'Exact alias match'
        WHEN EXISTS (SELECT 1 FROM unnest(sd.keywords) term WHERE lower(term) = ${normalized}) THEN 'Exact identifier match'
        WHEN lower(sd.title) LIKE ${`${normalized}%`} THEN 'Title prefix match'
        WHEN EXISTS (SELECT 1 FROM unnest(sd.aliases) term WHERE lower(term) LIKE ${`${normalized}%`}) THEN 'Alias prefix match'
        WHEN EXISTS (SELECT 1 FROM unnest(sd.keywords) term WHERE lower(term) LIKE ${`${normalized}%`}) THEN 'Identifier prefix match'
        WHEN to_tsvector('simple', sd.title) @@ q.query THEN 'Title text match'
        WHEN to_tsvector('simple', array_to_string(sd.aliases, ' ')) @@ q.query THEN 'Alias text match'
        WHEN to_tsvector('simple', array_to_string(sd.keywords, ' ')) @@ q.query THEN 'Identifier text match'
        WHEN sd."searchVector" @@ q.query THEN 'Body text match'
        ELSE 'Title typo match'
      END AS "matchReason",
      ${matchTerms} AS "matchTerms"
    FROM candidates
    JOIN "SearchDocument" sd ON sd.id = candidates.id
    CROSS JOIN q
    ORDER BY
      CASE WHEN lower(sd."shortcode") = ${normalized} THEN 0
           WHEN lower(sd.title) = ${normalized} THEN 1
           WHEN EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) = ${normalized}) THEN 2
           WHEN lower(sd.title) LIKE ${`${normalized}%`} OR EXISTS (SELECT 1 FROM unnest(sd.aliases || sd.keywords) term WHERE lower(term) LIKE ${`${normalized}%`}) THEN 3
           WHEN sd."searchVector" @@ q.query THEN 4 ELSE 5 END,
      ts_rank_cd(sd."searchVector", q.query) DESC,
      similarity(sd."normalizedText", ${normalized}) DESC,
      sd."updatedAt" DESC, sd."shortcode" ASC
    LIMIT ${limit}
  `,
      );
      span.setAttributes({
        "search.query_length": normalized.length,
        "search.scope_count": entityTypes.length,
        "search.limit": limit,
        "search.candidate_count": candidates.length,
      });
      return candidates;
    },
  );
  return rows;
}

export async function findSearchHits(
  db: Database,
  input: ServiceSearchQueryInput,
): Promise<SearchHit[]> {
  return withThumbnails(db, await findLexicalSearchCandidates(db, input, 50));
}

/** Ranked semantic candidates without presentation hydration. */
export async function findRelatedSearchCandidates(
  db: Database | undefined,
  input: ServiceSearchQueryInput,
  port: RelatedSearchPort = productionRelatedSearchPort,
  maxLimit = 50,
): Promise<InternalRelatedSearchCandidates> {
  if (
    input.query.trim().length < SEMANTIC_MIN_QUERY_LENGTH ||
    !port.configured()
  )
    return { status: "unavailable", results: [] };
  if (!db) throw new Error("Configured related search requires a database.");
  try {
    const embedding = await port.embed(input.query, { db });
    if (!embedding) return { status: "unavailable", results: [] };
    const limit = Math.min(Math.max(input.limit ?? 5, 1), maxLimit);
    const entityTypes = scopes(input.entityTypes);
    const matchTerms = searchTerms(input.query);
    const refs = await findSemanticEntityCandidates(
      port.vectorStore,
      embedding,
      { entityTypes, limit },
    );
    // Ghosts (a stale vector for a deleted/never-indexed entity) drop out
    // here: hydration only returns rows with a live SearchDocument, so the
    // result can legitimately be shorter than `refs`/`limit`.
    const hits = await hydrateSearchHitRefs(db, refs);
    const hitByRef = new Map(
      hits.map((hit) => [`${hit.entityType}:${hit.entityId}`, hit] as const),
    );
    const results: InternalSearchCandidate[] = refs.flatMap((ref) => {
      const hit = hitByRef.get(`${ref.entityType}:${ref.entityId}`);
      if (!hit) return [];
      const { imageUrl: _imageUrl, ...candidate } = hit;
      return [
        {
          ...candidate,
          matchKind: "semantic",
          matchField: "embedding",
          matchReason: "Related meaning match",
          matchTerms,
        },
      ];
    });
    return { status: "ready", results };
  } catch (error) {
    console.warn("search.related.failed", { message: getErrorMessage(error) });
    return { status: "unavailable", results: [] };
  }
}

/** Semantic results remain a separate section and never block lexical hits. */
export async function findRelatedSearchHits(
  db: Database | undefined,
  input: ServiceSearchQueryInput,
  port: RelatedSearchPort = productionRelatedSearchPort,
): Promise<RelatedSearchOut> {
  const related = await findRelatedSearchCandidates(db, input, port, 12);
  if (related.status === "unavailable") return related;
  if (!db) throw new Error("Configured related search requires a database.");
  return {
    status: "ready",
    results: await withThumbnails(db, related.results),
  };
}

/**
 * Hydrate already-ranked private refs through the same compact document and
 * thumbnail projection used by global search. This is intentionally internal
 * to server services: callers must strip `entityId` before crossing an API
 * boundary.
 */
export async function hydrateSearchHitRefs(
  db: Database,
  refs: ReadonlyArray<{
    entityType: SearchableEntity;
    entityId: string;
  }>,
): Promise<InternalSearchHit[]> {
  if (refs.length === 0) return [];
  const values = sql.join(
    refs.map(
      (ref, index) =>
        sql`(${ref.entityType}::text, ${ref.entityId}::uuid, ${index}::integer)`,
    ),
    sql`, `,
  );
  const rows = await executeSearchDocumentSql(
    db,
    candidateSchema,
    sql`
      WITH refs("entityType", "entityId", ordinal) AS (VALUES ${values})
      SELECT sd."entityId"::text AS "entityId", sd."shortcode" AS id,
        sd."entityType", sd.title, sd.subtitle, sd."typeHint",
        'semantic' AS "matchKind", 'embedding' AS "matchField",
        'Related meaning match' AS "matchReason", ARRAY[]::text[] AS "matchTerms"
      FROM refs
      JOIN "SearchDocument" sd
        ON sd."entityType" = refs."entityType"
        AND sd."entityId" = refs."entityId"
        AND sd."deletedAt" IS NULL
      ORDER BY refs.ordinal
    `,
  );
  const images = await hydrateThumbnails(db, rows);
  return rows.map((row) => ({
    ...row,
    imageUrl: images.get(`${row.entityType}:${row.entityId}`) ?? null,
  }));
}
