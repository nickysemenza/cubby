import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityMembership } from "@cubby/schemas/entity-manifest";
import {
  embeddableEntities,
  type SearchableEntity,
  type SearchableEntityRef,
  searchableEntities,
  searchableEntitySchema,
} from "@cubby/schemas/search";
import { sha256Hex } from "@cubby/shared/sha256";
import { isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { normalizeSearchText } from "~/lib/search-normalization";
import { wasm } from "~/lib/wasm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { normalizeSearchTextSql } from "~/server/db/computed/search-normalization";
import {
  fanoutTarget,
  isFanoutInput,
  storedDerived,
} from "~/server/db/derived-declarations";
import {
  unwrapDb,
  isTransaction,
  uuidArrayParam,
  withTransactionOn,
} from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { loadSelectedDescriptions } from "~/server/domains/image/repo/image-description-selection";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  getEmbeddingTextsForRefs,
  type SearchableEntityText,
} from "~/server/generic/embedding/repo/entity-embedding";
import type { SemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { assertCurrentJob } from "~/server/generic/jobs/repo/execution";

interface SearchDocumentSource {
  entityKind: SearchableEntity;
  entityId: string;
  shortcode: string;
  title: string;
  subtitle: string | null;
  typeHint: string | null;
  aliases: string[];
  keywords: string[];
}

export interface SearchDocumentRefreshResult {
  status: "upserted" | "softDeleted" | "missing";
  entityKind: SearchableEntity;
  entityId: string;
}

/**
 * Direct image attachment evidence is indexed with its owner only. The branch
 * list is generated from the canonical gallery bindings, so borrowed display
 * images and unrelated relationship traversal never leak into search text.
 */
async function loadDirectImageSearchText(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
): Promise<Map<string, string>> {
  if (!refs.length) return new Map();
  const refValues = sql.join(
    refs.map((ref) => sql`(${ref.entityKind}::text, ${ref.entityId}::uuid)`),
    sql`, `,
  );
  const searchable = entityMembership(searchableEntities);
  // Every direct attachment — gallery photo, cookbook cover, vendor logo — is
  // one EntityAttachment row; `refs` already limits it to searchable owners.
  const branches = [
    ...(searchable.has("image")
      ? [
          sql`SELECT 'image'::text AS "entityKind", i.id::text AS "entityId", i.id AS "imageId"
          FROM "Image" i JOIN refs ON refs."entityKind" = 'image' AND refs."entityId" = i.id
          WHERE ${notDeleted("i")}`,
        ]
      : []),
    sql`SELECT e."kind" AS "entityKind", attachment."entityId"::text AS "entityId", attachment."imageId" AS "imageId"
        FROM "EntityAttachment" attachment
        JOIN "Entity" e ON e."id" = attachment."entityId"
        JOIN refs ON refs."entityKind" = e."kind" AND refs."entityId" = attachment."entityId"
        WHERE ${notDeleted("attachment")}`,
  ];
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
    shortcode: string;
  }>(sql`
    WITH refs("entityKind", "entityId") AS (VALUES ${refValues}),
    attached AS (${sql.join(branches, sql` UNION ALL `)})
    SELECT attached."entityKind", attached."entityId", image.shortcode
    FROM attached
    JOIN "Image" image ON image.id = attached."imageId" AND ${notDeleted("image")}
  `);
  const selected = await loadSelectedDescriptions(db, [
    ...new Set(result.rows.map((row) => row.shortcode)),
  ]);
  const values = new Map<string, string>();
  for (const row of result.rows) {
    const text = selected.get(row.shortcode)?.trim();
    if (!text) continue;
    const key = entityRefKey(row.entityKind, row.entityId);
    values.set(key, [values.get(key), text].filter(Boolean).join("\n"));
  }
  return values;
}

/** Internal query boundary for the search service's indexed retrieval SQL. */
export async function executeSearchDocumentSql<Schema extends z.ZodType>(
  db: Database | DrizzleTransaction,
  rowSchema: Schema,
  query: SQL,
): Promise<Array<z.output<Schema>>> {
  const result = await unwrapDb(db).execute(query);
  return z.array(rowSchema).parse(result.rows);
}

/**
 * The identity of a written row: every projected column plus the semantic body.
 *
 * The writer and the staleness check deliberately share this one function.
 * Spelling the comparison out field by field would leave a rule that quietly
 * stops covering whatever column is added to `SearchDocumentSource` next, and
 * comparing the semantic body alone covers a projected column only where that
 * column happens to also appear in the embedding text — `project.emoji` never
 * does, and a `typeHint` outliving its enum is exactly the drift that hides
 * there (#750 narrowed the location enum and nothing re-projected the 100
 * documents still carrying a retired value).
 */
async function searchDocumentSourceHash(
  source: SearchDocumentSource,
  body: string,
): Promise<string> {
  return sha256Hex(JSON.stringify({ ...source, body }));
}

const textList = (values: Array<string | null | undefined>): string[] =>
  values.flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  });

/**
 * The document metadata projection. Semantic text is deliberately loaded by
 * the existing canonical embedding-text builders below; this keeps the two
 * indexes searchable by exactly the same relationship-derived language.
 */
type SearchSourcePage = {
  cursor?: SearchDocumentCursor;
  pageSize?: number;
  /** A refresh pass's frozen cutoff: only sources created by then. */
  createdBefore?: string;
};

async function searchDocumentSourceSql(
  entityKinds: SearchableEntity[],
  entityIds?: readonly string[],
  page?: SearchSourcePage,
) {
  const selectedKinds = [...new Set(entityKinds)];
  if (selectedKinds.length === 0) return null;

  const types = sql.join(
    entityKinds.map((entityKind) => sql`${entityKind}`),
    sql`, `,
  );
  // ONE bind parameter for the whole id set, not one per id: a Postgres array
  // literal bound as text and cast in SQL, via the only constructor the
  // `hand-rolled-any-array` guard accepts. It is deliberately NOT a JS array
  // interpolated into `sql` — drizzle renders that as a row constructor — and
  // not `eqAny`/`inArray`, which emit `IN ($1, …, $n)`: this is raw SQL over
  // independently aliased branches, and a parameter per id is the cost being removed.
  const hasIds = entityIds != null;

  /**
   * The shared id gate — an absent set means "no gate", not "match nothing".
   *
   * `= ANY` and not `IN (SELECT unnest(...))` over a CTE: with a BOUND
   * parameter the planner cannot see into the subquery, so that form degrades
   * every arm to a hashed SubPlan over a full table scan. Measured on
   * production, fetching one row by uuid: 270 buffers against 3.
   */
  const requested = (column: SQL) =>
    hasIds ? sql`${column} = ANY(${uuidArrayParam(entityIds)})` : sql`TRUE`;
  const createdBefore = page?.createdBefore;
  /** The same cutoff gates the paged rows and the pass's frozen COUNT. */
  const bounded = (column: SQL) =>
    createdBefore ? sql`${column} <= ${createdBefore}::timestamp` : sql`TRUE`;

  const context = { types, requested, bounded, entityIds, page };
  // Lazy: domain repositories import this module, and the scaffold registry
  // imports every repository.
  const { kernelScaffold } = await import("~/server/entity-kernel/scaffolds");
  const ports = selectedKinds.map((kind) => {
    const port = kernelScaffold(kind)?.search;
    if (!port) throw new Error(`${kind} has no search read port`);
    return port;
  });

  // An empty typed arm owns the shared columns independently of the first
  // requested kind. Only requested source builders are constructed/planned.
  const header = sql`SELECT NULL::text AS "entityKind", NULL::text AS "entityId",
    NULL::text AS shortcode, NULL::text AS title, NULL::text AS subtitle,
    NULL::text AS "typeHint", ARRAY[]::text[] AS aliases,
    ARRAY[]::text[] AS keywords WHERE false`;
  const union = sql.join(
    [header, ...ports.map((port) => port.document(context))],
    sql` UNION ALL `,
  );

  const cursor = page?.cursor
    ? sql`WHERE (source."entityKind", source."entityId"::uuid) > (${page.cursor.entityKind}, ${page.cursor.entityId}::uuid)`
    : sql``;
  const limit = page?.pageSize ? sql`LIMIT ${page.pageSize}` : sql``;
  const sourcePrefix = sql.join(
    ports.flatMap((port) => (port.prefix ? [port.prefix(context)] : [])),
    sql` `,
  );
  return { sourcePrefix, union, cursor, limit };
}

/** One COUNT over the sources a repair pass pages, under the same cutoff. */
export async function countSearchDocumentSources(
  db: Database | DrizzleTransaction,
  entityKinds: SearchableEntity[],
  createdBefore: string,
): Promise<number> {
  const query = await searchDocumentSourceSql(entityKinds, undefined, {
    createdBefore,
  });
  if (!query) return 0;
  const result = await unwrapDb(db).execute<{ count: number }>(sql`
    ${query.sourcePrefix}
    SELECT count(*)::int AS count FROM (${query.union}) source
  `);
  return result.rows[0]?.count ?? 0;
}

async function getSearchDocumentSources(
  db: Database | DrizzleTransaction,
  entityKinds: SearchableEntity[],
  entityIds?: readonly string[],
  page?: SearchSourcePage,
): Promise<SearchDocumentSource[]> {
  const query = await searchDocumentSourceSql(entityKinds, entityIds, page);
  if (!query) return [];
  const { sourcePrefix, union, cursor, limit } = query;
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
    shortcode: string;
    title: string;
    subtitle: string | null;
    typeHint: string | null;
    aliases: string[] | null;
    keywords: string[] | null;
  }>(sql`
    ${sourcePrefix}
    SELECT * FROM (${union}) source
    ${cursor}
    ORDER BY source."entityKind", source."entityId"::uuid
    ${limit}
  `);
  return result.rows.map((row) => {
    const keywords = textList(row.keywords ?? []);
    return {
      ...row,
      aliases: textList(row.aliases ?? []),
      keywords:
        row.entityKind === "product" || row.entityKind === "inventory"
          ? [
              ...new Set(
                keywords.flatMap((keyword) =>
                  wasm.product_code_search_terms(keyword),
                ),
              ),
            ]
          : keywords,
    };
  });
}

async function getSearchDocumentPage(
  db: Database | DrizzleTransaction,
  options: SearchSourcePage = {},
): Promise<{
  refs: Array<{ entityKind: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
}> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 250, 1), 250);
  const cursor = options.cursor
    ? sql`AND ("entityKind", "entityId") > (${options.cursor.entityKind}, ${options.cursor.entityId}::uuid)`
    : sql``;
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
  }>(sql`
    SELECT "entityKind", "entityId"::text AS "entityId"
    FROM "SearchDocument"
    WHERE ${notDeleted("SearchDocument")} ${cursor}
      ${options.createdBefore ? sql`AND "createdAt" <= ${options.createdBefore}::timestamp` : sql``}
    ORDER BY "entityKind", "entityId"
    LIMIT ${pageSize}
  `);
  const last = result.rows.at(-1);
  return {
    refs: result.rows,
    nextCursor: last && result.rows.length === pageSize ? last : null,
  };
}

export async function getSearchDocumentSourceRepairPage(
  db: Database | DrizzleTransaction,
  entityKinds: SearchableEntity[],
  options: SearchSourcePage = {},
): Promise<{
  refs: Array<{ entityKind: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
  scannedCount: number;
  missingCount: number;
  staleCount: number;
}> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 250, 1), 250);
  const sources = await getSearchDocumentSources(db, entityKinds, undefined, {
    cursor: options.cursor,
    pageSize,
    createdBefore: options.createdBefore,
  });
  const idsByType = new Map<SearchableEntity, string[]>();
  for (const source of sources) {
    idsByType.set(source.entityKind, [
      ...(idsByType.get(source.entityKind) ?? []),
      source.entityId,
    ]);
  }
  const [texts, documents] = await Promise.all([
    getEmbeddingTextsForRefs(db, idsByType),
    unwrapDb(db).execute<{
      entityKind: SearchableEntity;
      entityId: string;
      sourceHash: string;
    }>(sql`
      SELECT "entityKind", "entityId"::text AS "entityId", "sourceHash"
      FROM "SearchDocument"
      WHERE ${notDeleted("SearchDocument")}
        AND "entityId" = ANY(${uuidArrayParam(sources.map((source) => source.entityId))})
    `),
  ]);
  const imageTexts = await loadDirectImageSearchText(
    db,
    sources.map((source) => ({
      entityKind: source.entityKind,
      entityId: source.entityId,
    })),
  );
  const textByRef = new Map(
    texts.map((text) => [entityRefKey(text.entityKind, text.entityId), text]),
  );
  const documentByRef = new Map(
    documents.rows.map((document) => [
      entityRefKey(document.entityKind, document.entityId),
      document,
    ]),
  );
  const refs: Array<{ entityKind: SearchableEntity; entityId: string }> = [];
  for (const source of sources) {
    const key = entityRefKey(source.entityKind, source.entityId);
    const text = textByRef.get(key);
    if (!text) continue;
    const document = documentByRef.get(key);
    if (
      !document ||
      document.sourceHash !==
        (await searchDocumentSourceHash(
          source,
          [text.embeddingText, imageTexts.get(key)]
            .filter((value): value is string => Boolean(value))
            .join("\n"),
        ))
    ) {
      refs.push({ entityKind: source.entityKind, entityId: source.entityId });
    }
  }
  const last = sources.at(-1);
  return {
    refs,
    nextCursor:
      last && sources.length === pageSize
        ? { entityKind: last.entityKind, entityId: last.entityId }
        : null,
    scannedCount: sources.length,
    missingCount: refs.filter(
      (ref) => !documentByRef.has(entityRefKey(ref.entityKind, ref.entityId)),
    ).length,
    staleCount: refs.filter((ref) =>
      documentByRef.has(entityRefKey(ref.entityKind, ref.entityId)),
    ).length,
  };
}

export async function getSearchDocumentOrphanPage(
  db: Database | DrizzleTransaction,
  options: SearchSourcePage = {},
): Promise<{
  refs: Array<{ entityKind: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
  scannedCount: number;
  orphanedCount: number;
}> {
  const page = await getSearchDocumentPage(db, options);
  if (page.refs.length === 0)
    return { ...page, scannedCount: 0, orphanedCount: 0 };
  const refs = await getOrphanedSearchDocumentRefs(db, page.refs);
  return {
    ...page,
    refs,
    scannedCount: page.refs.length,
    orphanedCount: refs.length,
  };
}

/**
 * Recheck selected document refs against the authoritative source projection.
 *
 * Repair persists a page's candidates before applying them in a later
 * Workflow step. Keeping this recheck in the repository means the caller can
 * perform it inside the same transaction as the artifact retirement, rather
 * than treating an earlier keyset scan as a delete authorization.
 */
export async function getOrphanedSearchDocumentRefs(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
): Promise<Array<{ entityKind: SearchableEntity; entityId: string }>> {
  if (refs.length === 0) return [];
  const idsByType = new Map<SearchableEntity, string[]>();
  for (const ref of refs)
    idsByType.set(ref.entityKind, [
      ...(idsByType.get(ref.entityKind) ?? []),
      ref.entityId,
    ]);
  const [sources, texts] = await Promise.all([
    getSearchDocumentSources(
      db,
      [...idsByType.keys()],
      refs.map((ref) => ref.entityId),
    ),
    getEmbeddingTextsForRefs(db, idsByType),
  ]);
  const sourceRefs = new Set(
    sources.map((source) => entityRefKey(source.entityKind, source.entityId)),
  );
  const textRefs = new Set(
    texts.map((text) => entityRefKey(text.entityKind, text.entityId)),
  );
  return refs.filter((ref) => {
    const key = entityRefKey(ref.entityKind, ref.entityId);
    return !sourceRefs.has(key) || !textRefs.has(key);
  });
}

export async function refreshSearchDocument(
  db: Database | DrizzleTransaction,
  entityKind: SearchableEntity,
  entityId: string,
): Promise<SearchDocumentRefreshResult> {
  const [result] = await refreshSearchDocuments(db, [{ entityKind, entityId }]);
  return result ?? (await markSearchDocumentMissing(db, entityKind, entityId));
}

async function markSearchDocumentMissing(
  db: Database | DrizzleTransaction,
  entityKind: SearchableEntity,
  entityId: string,
): Promise<SearchDocumentRefreshResult> {
  await markSearchDocumentsMissing(db, [{ entityKind, entityId }]);
  return { status: "missing", entityKind, entityId };
}

async function markSearchDocumentsMissing(
  db: Database | DrizzleTransaction,
  refs: readonly SearchableEntityRef[],
): Promise<void> {
  if (!refs.length) return;
  const changed = await unwrapDb(db).execute(sql`
    UPDATE "SearchDocument" d SET "deletedAt" = now(), "updatedAt" = now()
    FROM jsonb_to_recordset(${JSON.stringify(refs)}::jsonb)
      AS wanted("entityKind" text, "entityId" uuid)
    WHERE d."entityKind" = wanted."entityKind" AND d."entityId" = wanted."entityId"
      AND ${notDeleted("d")}
    RETURNING d."entityId"`);
  if (changed.rows.length)
    await recordChange(db, {
      kind: "projection",
      categories: ["search", "relatedData", "problems"],
    });
}

/**
 * PostgreSQL rejects a tsvector over 1 MB, which a record carrying a large
 * encoded payload (an import's coverage digest, in its keywords or body) can
 * exceed; the full-text index reads a bounded prefix of each weighted part
 * (three parts stay under the limit together) while stored text stays complete.
 */
const SEARCH_VECTOR_PART_CHARS = 100_000;

// The partial-index inference predicate stays unqualified to match PostgreSQL index syntax.
async function upsertSearchDocumentBatch(
  db: Database | DrizzleTransaction,
  entries: ReadonlyArray<{ source: SearchDocumentSource; body: string }>,
  missing: readonly SearchableEntityRef[] = [],
): Promise<SearchDocumentRefreshResult[]> {
  if (entries.length === 0 && missing.length === 0) return [];
  const rows = await Promise.all(
    entries.map(async ({ source, body }) => {
      const normalizedText = normalizeSearchText(source.title);
      const sourceHash = await searchDocumentSourceHash(source, body);
      return {
        ...source,
        body,
        normalizedText,
        sourceHash,
        semanticText: body,
      };
    }),
  );
  const changed = await unwrapDb(db).execute(sql`
    WITH input AS MATERIALIZED (
      SELECT i.*, NULL::tsvector AS "searchVector", false AS missing FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS i("entityKind" text, "entityId" uuid, title text, subtitle text,
          "typeHint" text, aliases text[], keywords text[], body text,
          "normalizedText" text, "sourceHash" text, "semanticText" text)
      UNION ALL
      SELECT d."entityKind", d."entityId", d.title, d.subtitle, d."typeHint",
        d.aliases, d.keywords, d.body, d."normalizedText", d."sourceHash", d."semanticText", d."searchVector", true
      FROM "SearchDocument" d
      JOIN jsonb_to_recordset(${JSON.stringify(missing)}::jsonb)
        AS wanted("entityKind" text, "entityId" uuid)
        ON d."entityKind" = wanted."entityKind" AND d."entityId" = wanted."entityId"
      WHERE ${isNull(sql`d."deletedAt"`)}
    ), written AS (
    INSERT INTO "SearchDocument" (
      "entityKind", "entityId", title, subtitle, "typeHint",
      aliases, keywords, body, "semanticText", "normalizedText",
      "searchVector", "sourceHash"
    )
    SELECT input."entityKind", input."entityId", input.title,
      input.subtitle, input."typeHint", input.aliases, input.keywords,
      input.body, input."semanticText", input."normalizedText",
      coalesce(input."searchVector", setweight(to_tsvector('simple', left(input.title, ${SEARCH_VECTOR_PART_CHARS})), 'A') ||
      setweight(to_tsvector('simple', left(concat_ws(' ', input.subtitle, array_to_string(input.aliases, ' '), array_to_string(input.keywords, ' ')), ${SEARCH_VECTOR_PART_CHARS})), 'B') ||
      setweight(to_tsvector('simple', left(input.body, ${SEARCH_VECTOR_PART_CHARS})), 'D')), input."sourceHash"
    FROM input
    ORDER BY input."entityKind", input."entityId"
    ON CONFLICT ("entityKind", "entityId") WHERE "deletedAt" IS NULL DO UPDATE SET
      title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle, "typeHint" = EXCLUDED."typeHint",
      aliases = EXCLUDED.aliases, keywords = EXCLUDED.keywords,
      body = EXCLUDED.body, "semanticText" = EXCLUDED."semanticText",
      "normalizedText" = EXCLUDED."normalizedText",
      "searchVector" = EXCLUDED."searchVector",
      "sourceHash" = EXCLUDED."sourceHash", "updatedAt" = now(),
      "deletedAt" = NULL
    WHERE NOT EXISTS (SELECT 1 FROM input retired WHERE retired.missing
      AND retired."entityKind" = EXCLUDED."entityKind" AND retired."entityId" = EXCLUDED."entityId")
      AND ("SearchDocument"."sourceHash" IS DISTINCT FROM EXCLUDED."sourceHash"
      OR "SearchDocument".body IS DISTINCT FROM EXCLUDED.body
      OR "SearchDocument"."semanticText" IS DISTINCT FROM EXCLUDED."semanticText"
      OR "SearchDocument".title IS DISTINCT FROM EXCLUDED.title)
    RETURNING "entityKind"
    ) SELECT (SELECT count(*)::int FROM written) AS changed,
      coalesce(jsonb_agg(jsonb_build_object('entityKind', input."entityKind", 'entityId', input."entityId"))
        FILTER (WHERE input.missing), '[]'::jsonb) AS missing
      FROM input
  `);
  const publication = z
    .object({
      changed: z.number(),
      missing: z.array(
        z.object({ entityKind: searchableEntitySchema, entityId: z.string() }),
      ),
    })
    .parse(changed.rows[0]);
  // The sorted upsert also locks existing missing rows without changing their
  // text. Retire only those observed rows after every publication lock is held;
  // missing records that had no document never acquire placeholder documents.
  await markSearchDocumentsMissing(db, publication.missing);
  if (publication.changed)
    await recordChange(db, {
      kind: "projection",
      categories: ["search", "relatedData", "problems"],
    });
  return entries.map(({ source }) => ({
    status: "upserted",
    entityKind: source.entityKind,
    entityId: source.entityId,
  }));
}

export async function prepareSearchDocuments(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
) {
  const idsByType = new Map<SearchableEntity, string[]>();
  for (const ref of refs) {
    const ids = idsByType.get(ref.entityKind);
    if (ids) ids.push(ref.entityId);
    else idsByType.set(ref.entityKind, [ref.entityId]);
  }

  // Two queries for the whole wave, not two per ref. The id set is passed
  // whole rather than per type: each UNION arm is already gated on its own
  // entity type, and ids are uuids, so an id belonging to another type simply
  // matches nothing in the arms it was not meant for.
  const [sources, texts, imageTexts] = await Promise.all([
    getSearchDocumentSources(
      db,
      [...idsByType.keys()],
      refs.map((ref) => ref.entityId),
    ),
    getEmbeddingTextsForRefs(db, idsByType),
    loadDirectImageSearchText(db, refs),
  ]);

  const sourceByRef = new Map(
    sources.map((source) => [
      entityRefKey(source.entityKind, source.entityId),
      source,
    ]),
  );
  const textByRef = new Map(
    texts.map((text) => [entityRefKey(text.entityKind, text.entityId), text]),
  );

  const missing: SearchableEntityRef[] = [];
  const entries: Array<{ source: SearchDocumentSource; body: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = entityRefKey(ref.entityKind, ref.entityId);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = sourceByRef.get(key);
    const text = textByRef.get(key);
    if (source && text) {
      entries.push({
        source,
        body: [text.embeddingText, imageTexts.get(key)]
          .filter((value): value is string => Boolean(value))
          .join("\n"),
      });
      continue;
    }
    missing.push(ref);
  }

  return { entries, missing };
}

export async function publishPreparedSearchDocuments(
  db: Database | DrizzleTransaction,
  prepared: Awaited<ReturnType<typeof prepareSearchDocuments>>,
): Promise<SearchDocumentRefreshResult[]> {
  await assertCurrentJob(db);
  const entries = [...prepared.entries].sort((a, b) =>
    entityRefKey(a.source.entityKind, a.source.entityId).localeCompare(
      entityRefKey(b.source.entityKind, b.source.entityId),
    ),
  );
  if (!prepared.missing.length) return upsertSearchDocumentBatch(db, entries);
  const current = unwrapDb(db);
  return withTransactionOn(
    isTransaction(current) ? current : db,
    async (tx) => {
      const results: SearchDocumentRefreshResult[] = [
        ...(await upsertSearchDocumentBatch(tx, entries, prepared.missing)),
        ...prepared.missing.map((ref) => ({
          status: "missing" as const,
          ...ref,
        })),
      ];
      return results.sort((a, b) =>
        entityRefKey(a.entityKind, a.entityId).localeCompare(
          entityRefKey(b.entityKind, b.entityId),
        ),
      );
    },
  );
}

export async function refreshSearchDocuments(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
): Promise<SearchDocumentRefreshResult[]> {
  if (refs.length === 0) return [];
  return withTransactionOn(db, async (tx) => {
    const prepared = await prepareSearchDocuments(tx, refs);
    return publishPreparedSearchDocuments(tx, prepared);
  });
}

export async function getSearchDocumentEmbeddingText(
  db: Database | DrizzleTransaction,
  entityKind: SearchableEntity,
  entityId: string,
): Promise<SearchableEntityText | null> {
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
    embeddingText: string;
  }>(sql`
    SELECT "entityKind", "entityId"::text AS "entityId",
      "semanticText" AS "embeddingText"
    FROM "SearchDocument"
    WHERE "entityKind" = ${entityKind}
      AND "entityId" = ${entityId}::uuid
      AND ${notDeleted("SearchDocument")}
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

/**
 * The embedding bodies for a whole wave of refs in one round trip.
 *
 * Shaped like `hydrateSearchHitRefs`: a VALUES-joined ref table rather than an
 * `IN` list, so the pair `(entityKind, entityId)` is matched as a pair and the
 * result comes back in the caller's own order. Refs with no live document are
 * simply absent — the batch embedding path treats that as nothing to embed,
 * exactly as the single-ref loader's `null` does.
 */
export async function getSearchDocumentEmbeddingTexts(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityKind: SearchableEntity; entityId: string }>,
): Promise<SearchableEntityText[]> {
  if (refs.length === 0) return [];
  const values = sql.join(
    refs.map(
      (ref, index) =>
        sql`(${ref.entityKind}::text, ${ref.entityId}::uuid, ${index}::integer)`,
    ),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
    embeddingText: string;
  }>(sql`
    WITH refs("entityKind", "entityId", ordinal) AS (VALUES ${values})
    SELECT sd."entityKind", sd."entityId"::text AS "entityId",
      sd."semanticText" AS "embeddingText"
    FROM refs
    JOIN "SearchDocument" sd
      ON sd."entityKind" = refs."entityKind"
      AND sd."entityId" = refs."entityId"
      AND ${notDeleted("sd")}
    ORDER BY refs.ordinal
  `);
  return result.rows;
}

const SEARCH_DOCUMENT_WORKFLOW_PAGE_SIZE = 250;

// Bound as individual parameters, joined by a literal comma — never a JS
// array interpolated directly into `IN (...)`, which drizzle would render as
// a row constructor rather than a list (the `no-unsafe-sql-array-interpolation`
// Oxlint rule guards this).
const embeddableEntityKindsSql = sql.join(
  embeddableEntities.map((entityKind) => sql`${entityKind}`),
  sql`, `,
);

/**
 * Live, embeddable documents whose configured vector is missing or was
 * computed from different text. Restricted to `embeddableEntities`: the
 * three financial entities are searchable but never get an `EntityEmbedding`
 * row (see `entity-manifest.ts`), so without this filter they would show up
 * here forever. This predicate is shared by the Maintenance backlog count,
 * the Maintenance Run's embedding step, and the cron assertion so they
 * cannot disagree.
 */
/**
 * `updatedBefore` is a refresh pass's frozen cutoff: a document whose text
 * changed after the count waits for the next pass.
 */
const unembeddedDocumentsSql = (
  config: SemanticEmbeddingConfig,
  updatedBefore?: string,
): SQL => sql`
  FROM "SearchDocument" sd
  LEFT JOIN "EntityEmbedding" ee
    ON ee."entityKind" = sd."entityKind"
    AND ee."entityId" = sd."entityId"
    AND ee.provider = ${config.provider}
    AND ee.model = ${config.model}
    AND ee.dimensions = ${config.dimensions}
    AND ${notDeleted("ee")}
    AND ee."artifactState" = ${embeddingArtifactState.enum.selected} AND ee."artifactHash" IS NOT NULL AND ee."vectorHash" IS NOT NULL
    AND ee."observedAt" IS NOT NULL AND ee."indexedAt" IS NOT NULL
  WHERE ${notDeleted("sd")}
    AND sd."entityKind" IN (${embeddableEntityKindsSql})
    AND (ee.id IS NULL
      OR ${normalizeSearchTextSql(sql`ee."embeddingText"`)} <> ${normalizeSearchTextSql(sql`sd."semanticText"`)})
    ${updatedBefore ? sql`AND sd."updatedAt" <= ${updatedBefore}::timestamp` : sql``}
`;

/** Eligibility witness only: ANN recall is not an exhaustive similarity proof. */
/**
 * Semantic coverage is incomplete for these kinds while one of their search
 * documents awaits recompute (direct or fanout marks, ADR 0021) or lacks a
 * current embedding. One statement; the marks probe uses exact targets so it
 * stays a primary-key lookup.
 */
export async function searchCoverageIncomplete(
  db: Database | DrizzleTransaction,
  config: SemanticEmbeddingConfig,
  kinds: readonly SearchableEntity[],
): Promise<boolean> {
  if (!kinds.length) return false;
  const targets = kinds.flatMap((kind) => {
    const declaration = storedDerived(kind, "searchDocument");
    return declaration
      ? [
          declaration.target,
          ...declaration.inputs.flatMap((input, index) =>
            isFanoutInput(input)
              ? [fanoutTarget(declaration.target, index)]
              : [],
          ),
        ]
      : [];
  });
  const result = await unwrapDb(db).execute(sql`SELECT ${
    targets.length
      ? sql`EXISTS (
          SELECT 1 FROM "WorkItem" d WHERE d.target IN (${sql.join(
            targets.map((target) => sql`${target}`),
            sql`, `,
          )}) LIMIT 1
        ) OR `
      : sql``
  }EXISTS (
    SELECT 1 ${unembeddedDocumentsSql(config)}
      AND sd."entityKind" IN (${sql.join(
        kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )}) LIMIT 1
  ) AS missing`);
  return (
    z.array(z.object({ missing: z.boolean() })).parse(result.rows)[0]
      ?.missing ?? false
  );
}

export async function countUnembeddedSearchDocuments(
  db: Database | DrizzleTransaction,
  config: SemanticEmbeddingConfig,
  updatedBefore?: string,
): Promise<number> {
  const result = await unwrapDb(db).execute<{ count: number }>(sql`
    SELECT count(*)::int AS count ${unembeddedDocumentsSql(config, updatedBefore)}
  `);
  return result.rows[0]?.count ?? 0;
}

/** One keyset page of unembedded refs, for publishing refresh tasks. */
export async function selectUnembeddedSearchDocumentRefs(
  db: Database | DrizzleTransaction,
  config: SemanticEmbeddingConfig,
  options: {
    cursor?: SearchDocumentCursor;
    pageSize?: number;
    updatedBefore?: string;
  } = {},
): Promise<{
  refs: Array<{ entityKind: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
}> {
  const pageSize = Math.min(
    Math.max(options.pageSize ?? SEARCH_DOCUMENT_WORKFLOW_PAGE_SIZE, 1),
    SEARCH_DOCUMENT_WORKFLOW_PAGE_SIZE,
  );
  const cursor = options.cursor
    ? sql`AND (sd."entityKind", sd."entityId") > (${options.cursor.entityKind}, ${options.cursor.entityId}::uuid)`
    : sql``;
  const result = await unwrapDb(db).execute<{
    entityKind: SearchableEntity;
    entityId: string;
  }>(sql`
    SELECT sd."entityKind", sd."entityId"::text AS "entityId"
    ${unembeddedDocumentsSql(config, options.updatedBefore)}
    ${cursor}
    ORDER BY sd."entityKind", sd."entityId"
    LIMIT ${pageSize}
  `);
  const last = result.rows.at(-1);
  return {
    refs: result.rows,
    nextCursor:
      last && result.rows.length === pageSize
        ? { entityKind: last.entityKind, entityId: last.entityId }
        : null,
  };
}

export type SearchDocumentCursor = {
  entityKind: SearchableEntity;
  entityId: string;
};
