import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  type RelatedSearchOut,
  type SearchableEntity,
  type SearchHit,
  type SearchQueryInput,
  searchHitSchema,
  searchableEntities,
  searchableEntitySchema,
} from "@cubby/schemas/search";
import { getErrorMessage } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";
import { type SQL, sql, isNull } from "drizzle-orm";
import { z } from "zod";

import { normalizeSearchText } from "~/lib/search-normalization";
import { wasmFormat } from "~/lib/wasm";
import type { Database } from "~/server/db";
import { loadLocationAncestors } from "~/server/domains/location/repo/tree";
import { loadProductPlacementFacts } from "~/server/domains/product/repo/quantity-ledger";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import { loadRecordEmojiReferences } from "~/server/entity-kernel/repo/entity-emoji";
import { findSemanticEntityCandidates } from "~/server/generic/embedding/repo/entity-embedding-search";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/generic/embedding/service/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { executeSearchDocumentSql } from "~/server/generic/search/repo/search-document";
import {
  buildPrefixTsQuery,
  exactCodeMatch,
  searchTerms,
} from "~/server/generic/search/repo/search-lexical";
import { liveAliasSql } from "~/server/lib/live-row";
import { textArrayMatchSql } from "~/server/lib/name-alias-match";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const log = createLogger("search");

const candidateSchema = searchHitSchema.omit({ imageUrl: true }).extend({
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
  | { status: "ready"; results: InternalSearchCandidate[]; complete: boolean }
  | { status: "unavailable"; results: [] };

const productionRelatedSearchPort: RelatedSearchPort = {
  configured: semanticEmbeddingsConfigured,
  embed: embedQuery,
  vectorStore: productionVectorStore,
};

export {
  buildPrefixTsQuery,
  searchTerms,
} from "~/server/generic/search/repo/search-lexical";

const scopes = (entityKinds?: SearchableEntity[]) =>
  entityKinds?.length ? entityKinds : [...searchableEntities];

const textArray = (values: string[]): SQL =>
  values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;

async function hydrateThumbnails(
  db: Database,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
): Promise<Map<string, string | null>> {
  const images = await resolveEntityDisplayImages(db, refs);
  return new Map(
    refs.map((ref) => [
      entityRefKey(ref.entityKind, ref.entityId),
      images.get(entityRefKey(ref.entityKind, ref.entityId))?.url ?? null,
    ]),
  );
}

const searchLocationSchema = z.object({
  entityId: z.string(),
  locationId: z.string(),
  name: z.string(),
});

/** Location and inventory hits share one bounded location read and ancestor batch. */
const loadHitPaths = async (
  db: Database,
  candidates: InternalSearchCandidate[],
) => {
  const refs = candidates.filter(
    (hit) => hit.entityKind === "location" || hit.entityKind === "inventory",
  );
  if (refs.length === 0) return new Map<string, string>();
  const values = sql.join(
    refs.map((hit) => sql`(${hit.entityKind}::text, ${hit.entityId}::uuid)`),
    sql`, `,
  );
  const locations = await executeSearchDocumentSql(
    db,
    searchLocationSchema,
    sql`
    WITH refs(kind, id) AS (VALUES ${values})
    SELECT refs.id::text AS "entityId", l.id::text AS "locationId", l.name
    FROM refs
    LEFT JOIN "InventoryEntry" i ON refs.kind = ${searchableEntitySchema.enum.inventory} AND i.id = refs.id AND ${isNull(sql`i."deletedAt"`)}
    JOIN "Location" l ON l.id = CASE WHEN refs.kind = ${searchableEntitySchema.enum.location} THEN refs.id ELSE i."locationId" END
      AND ${isNull(sql`l."deletedAt"`)}
  `,
  );
  const paths = await loadLocationAncestors(
    db,
    locations.map((row) => parseEntityId("location", row.locationId)),
  );
  return new Map(
    locations.map((row) => [
      row.entityId,
      [
        ...(paths.get(parseEntityId("location", row.locationId)) ?? []).map(
          (rung) => rung.name,
        ),
        row.name,
      ].join(" › "),
    ]),
  );
};

const hydrateHits = async (
  db: Database,
  candidates: InternalSearchCandidate[],
): Promise<InternalSearchHit[]> => {
  const [emojis, images, paths, stock] = await Promise.all([
    loadRecordEmojiReferences(db, candidates),
    hydrateThumbnails(db, candidates),
    loadHitPaths(db, candidates),
    loadProductPlacementFacts(
      db,
      candidates
        .filter((hit) => hit.entityKind === "product")
        .map((hit) => parseEntityId("product", hit.entityId)),
    ),
  ]);
  return candidates.map((candidate) => {
    const { entityId } = candidate;
    const placement =
      candidate.entityKind === "product"
        ? stock.get(parseEntityId("product", entityId))
        : undefined;
    const path = paths.get(entityId);
    const facts =
      candidate.entityKind === "product"
        ? placement
          ? [
              placement.primaryPlacement.path,
              ...(placement.onHandUnits === null
                ? []
                : [
                    `${wasmFormat.format_number(placement.onHandUnits)} on hand`,
                  ]),
            ]
          : []
        : path
          ? [path]
          : [];
    return {
      ...candidate,
      facts,
      emoji: emojis.get(entityRefKey(candidate.entityKind, entityId)) ?? null,
      imageUrl:
        images.get(entityRefKey(candidate.entityKind, entityId)) ?? null,
    };
  });
};

const publicHits = (hits: InternalSearchHit[]): SearchHit[] =>
  hits.map(({ entityId: _entityId, ...hit }) => hit);

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
  const entityKinds = scopes(input.entityKinds);
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
      WHERE ${liveAliasSql("sd")}
        AND char_length(${normalized}) >= 3
        AND sd."entityKind" IN (${sql.join(
          entityKinds.map((type) => sql`${type}`),
          sql`, `,
        )})
        AND sd."normalizedText" % ${normalized}
      ORDER BY sd."normalizedText" <-> ${normalized}
      LIMIT ${Math.min(limit * 4, 200)}
    ),
    candidates AS (
      SELECT sd.id
      FROM "SearchDocument" sd CROSS JOIN q
      WHERE ${liveAliasSql("sd")}
        AND sd."entityKind" IN (${sql.join(
          entityKinds.map((type) => sql`${type}`),
          sql`, `,
        )})
        AND (
          ${exactCodeMatch(normalized)}
          OR lower(sd.title) = ${normalized}
          OR lower(sd.title) LIKE ${`${normalized}%`}
          OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "exact-or-prefix" })}
          OR sd."searchVector" @@ q.query
        )
      UNION
      SELECT id FROM fuzzy
    )
    SELECT sd."entityId"::text AS "entityId", e."shortcode" AS id, sd."entityKind", sd.title, sd.subtitle, sd."typeHint",
      CASE
        WHEN ${exactCodeMatch(normalized)} OR lower(sd.title) = ${normalized}
          OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "exact" })} THEN 'exact'
        WHEN lower(sd.title) LIKE ${`${normalized}%`} OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "prefix" })} THEN 'prefix'
        WHEN sd."searchVector" @@ q.query THEN 'text'
        ELSE 'fuzzy'
      END AS "matchKind",
      CASE
        WHEN ${exactCodeMatch(normalized)} THEN 'shortcode'
        WHEN lower(sd.title) = ${normalized} OR lower(sd.title) LIKE ${`${normalized}%`} THEN 'title'
        WHEN ${textArrayMatchSql({ values: sql`sd.aliases`, query: normalized, match: "exact-or-prefix" })} THEN 'alias'
        WHEN ${textArrayMatchSql({ values: sql`sd.keywords`, query: normalized, match: "exact-or-prefix" })} THEN 'keyword'
        WHEN to_tsvector('simple', sd.title) @@ q.query THEN 'title'
        WHEN to_tsvector('simple', array_to_string(sd.aliases, ' ')) @@ q.query THEN 'alias'
        WHEN to_tsvector('simple', array_to_string(sd.keywords, ' ')) @@ q.query THEN 'keyword'
        WHEN sd."searchVector" @@ q.query THEN 'body'
        ELSE 'title'
      END AS "matchField",
      CASE
        WHEN ${exactCodeMatch(normalized)} THEN 'Exact shortcode match'
        WHEN lower(sd.title) = ${normalized} THEN 'Exact title match'
        WHEN ${textArrayMatchSql({ values: sql`sd.aliases`, query: normalized, match: "exact" })} THEN 'Exact alias match'
        WHEN ${textArrayMatchSql({ values: sql`sd.keywords`, query: normalized, match: "exact" })} THEN 'Exact identifier match'
        WHEN lower(sd.title) LIKE ${`${normalized}%`} THEN 'Title prefix match'
        WHEN ${textArrayMatchSql({ values: sql`sd.aliases`, query: normalized, match: "prefix" })} THEN 'Alias prefix match'
        WHEN ${textArrayMatchSql({ values: sql`sd.keywords`, query: normalized, match: "prefix" })} THEN 'Identifier prefix match'
        WHEN to_tsvector('simple', sd.title) @@ q.query THEN 'Title text match'
        WHEN to_tsvector('simple', array_to_string(sd.aliases, ' ')) @@ q.query THEN 'Alias text match'
        WHEN to_tsvector('simple', array_to_string(sd.keywords, ' ')) @@ q.query THEN 'Identifier text match'
        WHEN sd."searchVector" @@ q.query THEN 'Body text match'
        ELSE 'Title typo match'
      END AS "matchReason",
      ${matchTerms} AS "matchTerms"
    FROM candidates
    JOIN "SearchDocument" sd ON sd.id = candidates.id
    JOIN "Entity" e ON e."id" = sd."entityId"
    CROSS JOIN q
    ORDER BY
      CASE WHEN ${exactCodeMatch(normalized)} THEN 0
           WHEN lower(sd.title) = ${normalized} THEN 1
           WHEN ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "exact" })} THEN 2
           WHEN lower(sd.title) LIKE ${`${normalized}%`} OR ${textArrayMatchSql({ values: sql`sd.aliases || sd.keywords`, query: normalized, match: "prefix" })} THEN 3
           WHEN sd."searchVector" @@ q.query THEN 4 ELSE 5 END,
      ts_rank_cd(sd."searchVector", q.query) DESC,
      similarity(sd."normalizedText", ${normalized}) DESC,
      sd."updatedAt" DESC, e."shortcode" ASC
    LIMIT ${limit}
  `,
      );
      span.setAttributes({
        "search.query_length": normalized.length,
        "search.scope_count": entityKinds.length,
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
  return publicHits(
    await hydrateHits(db, await findLexicalSearchCandidates(db, input, 50)),
  );
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
    const entityKinds = scopes(input.entityKinds);
    const matchTerms = searchTerms(input.query);
    const scan = await findSemanticEntityCandidates(
      db,
      port.vectorStore,
      embedding,
      { entityKinds, limit, config: getSemanticEmbeddingConfig() },
    );
    // Ghosts (a stale vector for a deleted/never-indexed entity) drop out
    // here: hydration only returns rows with a live SearchDocument, so the
    // result can legitimately be shorter than `refs`/`limit`.
    const refs = scan.candidates;
    const hits = await hydrateSearchHitRefs(db, refs);
    const hitByRef = new Map(
      hits.map((hit) => [`${hit.entityKind}:${hit.entityId}`, hit] as const),
    );
    const results: InternalSearchCandidate[] = refs.flatMap((ref) => {
      const hit = hitByRef.get(`${ref.entityKind}:${ref.entityId}`);
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
    return { status: "ready", results, complete: scan.complete };
  } catch (error) {
    log.warn("related failed", { message: getErrorMessage(error) });
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
    complete: related.complete,
    results: publicHits(await hydrateHits(db, related.results)),
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
    entityKind: SearchableEntity;
    entityId: string;
  }>,
): Promise<InternalSearchHit[]> {
  if (refs.length === 0) return [];
  const values = sql.join(
    refs.map(
      (ref, index) =>
        sql`(${ref.entityKind}::text, ${ref.entityId}::uuid, ${index}::integer)`,
    ),
    sql`, `,
  );
  const rows = await executeSearchDocumentSql(
    db,
    candidateSchema,
    sql`
      WITH refs("entityKind", "entityId", ordinal) AS (VALUES ${values})
      SELECT sd."entityId"::text AS "entityId", e."shortcode" AS id,
        sd."entityKind", sd.title, sd.subtitle, sd."typeHint",
        'semantic' AS "matchKind", 'embedding' AS "matchField",
        'Related meaning match' AS "matchReason", ARRAY[]::text[] AS "matchTerms"
      FROM refs
      JOIN "SearchDocument" sd
        ON sd."entityKind" = refs."entityKind"
        AND sd."entityId" = refs."entityId"
        AND ${liveAliasSql("sd")}
      JOIN "Entity" e ON e."id" = sd."entityId"
      ORDER BY refs.ordinal
    `,
  );
  return hydrateHits(db, rows);
}
