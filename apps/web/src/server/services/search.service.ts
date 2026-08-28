import { searchDocumentRepairCoordinatorPayloadSchema } from "@cubby/schemas/background-jobs";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  type RelatedSearchOut,
  type RepairSearchDocumentsOut,
  type SearchableEntity,
  type SearchHit,
  type SearchQueryInput,
  searchableEntities,
} from "@cubby/schemas/search";
import { type SQL, sql } from "drizzle-orm";
import type { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import {
  continueWorkflow,
  startOrReuseWorkflow,
} from "~/server/background-workflow";
import type { Database } from "~/server/db";
import { findLatestBackgroundWorkflow } from "~/server/repo/background-jobs";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import {
  executeSearchDocumentSql,
  getSearchDocumentOrphanPage,
  getSearchDocumentSourceRepairPage,
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
  candidates: Candidate[],
): Promise<SearchHit[]> => {
  const images = await hydrateThumbnails(db, candidates);
  return candidates.map(({ entityId, ...candidate }) => ({
    ...candidate,
    imageUrl: images.get(entityRefKey(candidate.entityType, entityId)) ?? null,
  }));
};

type SearchDocumentRepairMetadata = z.output<
  typeof searchDocumentRepairCoordinatorPayloadSchema
>;
type SearchDocumentRepairMetadataInput = z.input<
  typeof searchDocumentRepairCoordinatorPayloadSchema
>;

const readSearchDocumentRepairMetadata = (
  value: unknown,
): SearchDocumentRepairMetadata | null => {
  const parsed = searchDocumentRepairCoordinatorPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Process one bounded document-repair audit page. */
export async function continueSearchDocumentRepairWorkflow(
  db: Database,
  batchId: string,
  payload: unknown,
): Promise<"succeeded" | "skipped"> {
  const metadata = readSearchDocumentRepairMetadata(payload);
  if (!metadata || metadata.workflow.state === "complete") return "skipped";
  const page =
    metadata.workflow.phase === "missing"
      ? await getSearchDocumentSourceRepairPage(db, [...searchableEntities], {
          cursor: metadata.workflow.cursor ?? undefined,
        })
      : await getSearchDocumentOrphanPage(db, {
          cursor: metadata.workflow.cursor ?? undefined,
        });
  const nextPhase =
    metadata.workflow.phase === "documents" && !page.nextCursor
      ? "missing"
      : metadata.workflow.phase;
  const complete = metadata.workflow.phase === "missing" && !page.nextCursor;
  const next: SearchDocumentRepairMetadataInput = {
    ...metadata,
    workflow: {
      ...metadata.workflow,
      phase: nextPhase,
      cursor: page.nextCursor,
      scanned: metadata.workflow.scanned + page.scannedCount,
      queued:
        metadata.workflow.queued +
        (metadata.workflow.phase === "missing" ? page.refs.length : 0),
      retired:
        metadata.workflow.retired +
        ("orphanedCount" in page ? page.orphanedCount : 0),
      missing:
        metadata.workflow.missing +
        ("missingCount" in page ? page.missingCount : 0),
      stale:
        metadata.workflow.stale + ("staleCount" in page ? page.staleCount : 0),
      orphaned:
        metadata.workflow.orphaned +
        ("orphanedCount" in page ? page.orphanedCount : 0),
      state: complete ? "complete" : "active",
    },
  };
  await continueWorkflow(db, {
    batchId,
    batchKind: "search-document.repair.coordinator",
    metadata: next,
    // Both repair paths use the canonical refresh worker. Missing/stale source
    // rows are rebuilt; orphan refs resolve missing and are soft-deleted. The
    // jobs and the page counters are persisted together before delivery.
    children: page.refs.map((ref) => ({
      kind: "entity-embedding.refresh" as const,
      dedupeKey: `search-document.repair:${metadata.workflow.phase}:${ref.entityType}:${ref.entityId}`,
      payload: ref,
    })),
    continuation: complete
      ? null
      : {
          kind: "search-document.repair.coordinator",
          dedupeKey: `search-document.repair:${batchId}:${metadata.workflow.phase}:${metadata.workflow.scanned}`,
          payload: next,
        },
  });
  return "succeeded";
}

/**
 * Durably audit and repair missing, stale, and orphaned search documents through
 * the existing refresh job before doing any domain mutation.
 */
export async function repairSearchDocuments(
  db: Database,
): Promise<RepairSearchDocumentsOut> {
  const workflow = await startOrReuseWorkflow(db, {
    kind: "search-document.repair.coordinator",
    source: "maintenance",
    dedupeKey: "search-document-repair",
    metadata: {
      source: "search.documentRepair",
      reused: false,
      workflow: {
        type: "search-document.repair.coordinator",
        phase: "documents",
        cursor: null,
        scanned: 0,
        queued: 0,
        retired: 0,
        missing: 0,
        stale: 0,
        orphaned: 0,
        state: "active",
      },
    },
    initialJobs: [
      {
        kind: "search-document.repair.coordinator",
        dedupeKey: "search-document-repair:page:0",
        payload: {
          source: "search.documentRepair",
          workflow: {
            type: "search-document.repair.coordinator",
            phase: "documents",
            cursor: null,
            scanned: 0,
            queued: 0,
            retired: 0,
            missing: 0,
            stale: 0,
            orphaned: 0,
            state: "active",
          },
        } satisfies SearchDocumentRepairMetadataInput,
      },
    ],
  });
  return {
    batch: workflow.batch,
    reused: workflow.reused,
  };
}

/** Reads only persisted repair workflow metadata; never scans SearchDocument. */
export async function inspectSearchDocumentHealth(db: Database) {
  const batch = await findLatestBackgroundWorkflow(
    db,
    "search-document.repair.coordinator",
    "search-document-repair",
  );
  const metadata = batch
    ? readSearchDocumentRepairMetadata(batch.metadata)
    : null;
  const workflow = metadata?.workflow;
  const state = !batch
    ? "never-run"
    : batch.status === "queued" || batch.status === "running"
      ? "running"
      : batch.status === "succeeded"
        ? "completed"
        : "failed";
  const findings = {
    missing: workflow?.missing ?? 0,
    stale: workflow?.stale ?? 0,
    orphaned: workflow?.orphaned ?? 0,
    total:
      (workflow?.missing ?? 0) +
      (workflow?.stale ?? 0) +
      (workflow?.orphaned ?? 0),
  };
  return {
    state,
    batchId: batch?.id ?? null,
    findings,
    repaired: {
      queued: workflow?.queued ?? 0,
      retired: workflow?.retired ?? 0,
    },
    reused: metadata?.reused ?? false,
    completedAt:
      state === "completed" || state === "failed"
        ? (batch?.lastJobFinishedAt ?? null)
        : null,
  } as const;
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
