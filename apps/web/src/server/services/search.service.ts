import {
  type RelatedSearchOut,
  type RepairSearchDocumentsOut,
  type SearchableEntity,
  type SearchDocumentHealth,
  type SearchHit,
  type SearchQueryInput,
  searchableEntities,
} from "@cubby/schemas/search";
import { type SQL, sql } from "drizzle-orm";
import { getErrorMessage } from "~/lib/error-utils";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import {
  executeSearchDocumentSql,
  getSearchDocumentDiagnostics,
  retireOrphanedSearchDocuments,
} from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { normalizeSearchText } from "~/server/semantic/text";
import { TraceNames, withTrace } from "~/server/tracing";

type Candidate = Omit<SearchHit, "imageUrl"> & { entityId: string };
export type InternalSearchHit = SearchHit & { entityId: string };
type ServiceSearchQueryInput = Omit<SearchQueryInput, "limit"> & {
  limit?: number;
};

export const searchTerms = (query: string): string[] =>
  normalizeSearchText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

export const buildPrefixTsQuery = (query: string): string =>
  searchTerms(query)
    .map((term) => `${term.replace(/[':&|!()]/g, "")} :*`.replace(" ", ""))
    .join(" & ");

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
  if (!refs.length) return new Map();
  const values = sql.join(
    refs.map((ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`),
    sql`, `,
  );
  const rows = await executeSearchDocumentSql<{
    entityType: SearchableEntity;
    entityId: string;
    imageUrl: string | null;
  }>(
    db,
    sql`
    WITH refs("entityType", "entityId") AS (VALUES ${values})
    SELECT refs."entityType", refs."entityId"::text AS "entityId", (
      SELECT candidates.url FROM (
        SELECT i.url, pi."sortOrder", pi."createdAt", i.id AS "imageId" FROM "ProductImage" pi JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" IN ('product', 'inventory')
          AND pi."productId" = CASE WHEN refs."entityType" = 'product' THEN refs."entityId" ELSE (SELECT ie."productId" FROM "InventoryEntry" ie WHERE ie.id = refs."entityId" AND ie."deletedAt" IS NULL) END
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."contentType" <> 'application/pdf'
        UNION ALL
        SELECT i.url, ri."sortOrder", ri."createdAt", i.id AS "imageId" FROM "RecipeImage" ri JOIN "Image" i ON i.id = ri."imageId"
        WHERE refs."entityType" = 'recipe' AND ri."recipeId" = refs."entityId" AND ri."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."contentType" <> 'application/pdf'
        UNION ALL
        SELECT i.url, li."sortOrder", li."createdAt", i.id AS "imageId" FROM "LocationImage" li JOIN "Image" i ON i.id = li."imageId"
        WHERE refs."entityType" = 'location' AND li."locationId" = refs."entityId" AND li."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."contentType" <> 'application/pdf'
        UNION ALL
        SELECT i.url, 0 AS "sortOrder", c."createdAt", i.id AS "imageId" FROM "Cookbook" c JOIN "Image" i ON i.id = c."coverImageId"
        WHERE refs."entityType" = 'cookbook' AND c.id = refs."entityId" AND c."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."contentType" <> 'application/pdf'
        UNION ALL
        SELECT i.url, pri."sortOrder", pri."createdAt", i.id AS "imageId" FROM "ProjectImage" pri JOIN "Image" i ON i.id = pri."imageId"
        WHERE refs."entityType" = 'project' AND pri."projectId" = refs."entityId" AND pri."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."contentType" <> 'application/pdf'
        UNION ALL
        SELECT i.url, pui."sortOrder", pui."createdAt", i.id AS "imageId" FROM "PurchaseImage" pui JOIN "Image" i ON i.id = pui."imageId"
        WHERE refs."entityType" = 'purchase' AND pui."purchaseId" = refs."entityId" AND pui."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."contentType" <> 'application/pdf'
      ) candidates
      ORDER BY candidates."sortOrder", candidates."createdAt", candidates."imageId"
      LIMIT 1
    ) AS "imageUrl"
    FROM refs
  `,
  );
  return new Map(
    rows.map((row) => [`${row.entityType}:${row.entityId}`, row.imageUrl]),
  );
}

const withThumbnails = async (
  db: Database,
  candidates: Candidate[],
): Promise<SearchHit[]> => {
  const images = await hydrateThumbnails(db, candidates);
  return candidates.map(({ entityId, ...candidate }) => ({
    ...candidate,
    imageUrl: images.get(`${candidate.entityType}:${entityId}`) ?? null,
  }));
};

const documentHealth = (
  diagnostics: Awaited<ReturnType<typeof getSearchDocumentDiagnostics>>,
): SearchDocumentHealth => ({
  missing: diagnostics.missing.length,
  orphaned: diagnostics.orphaned.length,
  stale: diagnostics.stale.length,
  total:
    diagnostics.missing.length +
    diagnostics.orphaned.length +
    diagnostics.stale.length,
});

/** Aggregate-only health: private entity UUIDs never cross the search interface. */
export async function inspectSearchDocumentHealth(
  db: Database,
): Promise<SearchDocumentHealth> {
  return documentHealth(await getSearchDocumentDiagnostics(db));
}

/**
 * Retire orphaned rows now, then durably refresh missing/stale documents through
 * the existing queue job that rebuilds SearchDocument before embeddings.
 */
export async function repairSearchDocuments(
  db: Database,
): Promise<RepairSearchDocumentsOut> {
  const diagnostics = await getSearchDocumentDiagnostics(db);
  const before = documentHealth(diagnostics);
  const retired = await retireOrphanedSearchDocuments(db, diagnostics.orphaned);
  const refs = [...diagnostics.missing, ...diagnostics.stale];
  if (refs.length === 0) {
    return { before, queued: 0, retired, batchId: null };
  }
  const dispatched = await dispatchBackgroundJobs(db, {
    kind: "entity-embedding.refresh",
    source: "maintenance",
    metadata: {
      source: "search.documentRepair",
      missing: diagnostics.missing.length,
      stale: diagnostics.stale.length,
      orphaned: diagnostics.orphaned.length,
    },
    jobs: refs.map((ref) => ({
      kind: "entity-embedding.refresh" as const,
      dedupeKey: `search-document.repair:${ref.entityType}:${ref.entityId}`,
      payload: ref,
    })),
  });
  return {
    before,
    queued: dispatched.jobIds.length,
    retired,
    batchId: dispatched.batchId,
  };
}

/** One indexed lexical candidate query; rank before applying the caller limit. */
export async function findSearchHits(
  db: Database,
  input: ServiceSearchQueryInput,
): Promise<SearchHit[]> {
  const normalized = normalizeSearchText(input.query);
  const tsQuery = buildPrefixTsQuery(input.query);
  if (!normalized || !tsQuery) return [];
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);
  const entityTypes = scopes(input.entityTypes);
  const matchTerms = textArray(searchTerms(input.query));
  const rows = await withTrace(
    TraceNames.service("search", "lexicalCandidates"),
    async (span) => {
      const candidates = await executeSearchDocumentSql<Candidate>(
        db,
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
  return withThumbnails(db, rows);
}

/** Semantic candidates remain a separate section and never block lexical hits. */
export async function findRelatedSearchHits(
  db: Database,
  input: ServiceSearchQueryInput,
): Promise<RelatedSearchOut> {
  if (
    input.query.trim().length < SEMANTIC_MIN_QUERY_LENGTH ||
    !semanticEmbeddingsConfigured()
  )
    return { status: "unavailable", results: [] };
  try {
    const embedding = await embedQuery(input.query, { db });
    if (!embedding) return { status: "unavailable", results: [] };
    const config = getSemanticEmbeddingConfig();
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 12);
    const entityTypes = scopes(input.entityTypes);
    const matchTerms = textArray(searchTerms(input.query));
    // One bound parameter, not ~30 KB of inlined literal re-parsed per search.
    // The HNSW index scan is preserved (verified by EXPLAIN on production).
    const vector = sql`${`[${embedding.join(",")}]`}::vector`;
    const cast = sql.raw(`ee."embedding"::vector(${config.dimensions})`);
    // Keep this literal in lockstep with EntityEmbedding's partial HNSW index;
    // a bound parameter prevents PostgreSQL proving that index predicate.
    const dimensionsFilter = sql.raw(`ee."dimensions" = ${config.dimensions}`);
    const rows = await executeSearchDocumentSql<Candidate>(
      db,
      sql`
      SELECT sd."entityId"::text AS "entityId", sd."shortcode" AS id, sd."entityType", sd.title, sd.subtitle, sd."typeHint",
        'semantic' AS "matchKind", 'embedding' AS "matchField",
        'Related meaning match' AS "matchReason", ${matchTerms} AS "matchTerms"
      FROM "EntityEmbedding" ee
      JOIN "SearchDocument" sd ON sd."entityType" = ee."entityType" AND sd."entityId" = ee."entityId" AND sd."deletedAt" IS NULL
      WHERE ee."deletedAt" IS NULL AND ee.provider = ${config.provider} AND ee.model = ${config.model}
        AND ${dimensionsFilter}
        AND sd."entityType" IN (${sql.join(
          entityTypes.map((type) => sql`${type}`),
          sql`, `,
        )})
      ORDER BY ${cast} <=> ${vector}
      LIMIT ${limit}
    `,
    );
    return { status: "ready", results: await withThumbnails(db, rows) };
  } catch (error) {
    console.warn("search.related.failed", { message: getErrorMessage(error) });
    return { status: "unavailable", results: [] };
  }
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
  const rows = await executeSearchDocumentSql<Candidate>(
    db,
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
