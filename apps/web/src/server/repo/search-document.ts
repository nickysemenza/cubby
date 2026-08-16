import {
  type SearchableEntity,
  searchableEntities,
} from "@cubby/schemas/search";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import {
  getEmbeddingTextsForEntityTypes,
  getEmbeddingTextsForRefs,
  type SearchableEntityText,
} from "~/server/repo/entity-embedding";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { embeddingTextHash } from "~/server/semantic/hash";
import { normalizeSearchText } from "~/server/semantic/text";

interface SearchDocumentSource {
  entityType: SearchableEntity;
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
  entityType: SearchableEntity;
  entityId: string;
}

export interface SearchDocumentDiagnostics {
  missing: Array<{ entityType: SearchableEntity; entityId: string }>;
  orphaned: Array<{ entityType: SearchableEntity; entityId: string }>;
  stale: Array<{ entityType: SearchableEntity; entityId: string }>;
}

/** Internal query boundary for the search service's indexed retrieval SQL. */
export async function executeSearchDocumentSql<T>(
  db: Database,
  query: SQL,
): Promise<T[]> {
  const result = await getDb(db).execute<Record<string, unknown>>(query);
  return result.rows as unknown as T[];
}

const hash = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const textList = (values: Array<string | null | undefined>): string[] =>
  values.flatMap((value) => {
    const trimmed = value?.trim();
    return trimmed ? [trimmed] : [];
  });

const textArray = (values: string[]): SQL =>
  values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;

/**
 * The document metadata projection. Semantic text is deliberately loaded by
 * the existing canonical embedding-text builders below; this keeps the two
 * indexes searchable by exactly the same relationship-derived language.
 */
async function getSearchDocumentSources(
  db: Database,
  entityTypes: SearchableEntity[],
  entityIds?: readonly string[],
): Promise<SearchDocumentSource[]> {
  const types = sql.join(
    entityTypes.map((entityType) => sql`${entityType}`),
    sql`, `,
  );
  // ONE bind parameter for the whole id set, not one per id: a Postgres array
  // literal bound as text and cast in SQL. It is deliberately NOT a JS array
  // interpolated into `sql` — drizzle renders that as a row constructor, the
  // trap `hand-rolled-any-array` guards. It is also not `eqAny`/`inArray`,
  // which emit `IN ($1, …, $n)`: this query is raw SQL over fifteen aliased
  // tables, and binding a parameter per id is the cost being removed. The
  // matching `requested` CTE below unnests it once; a null set skips the gate
  // entirely so the unfiltered backfill path is unchanged.
  const requestedIds =
    entityIds == null ? null : `{${[...new Set(entityIds)].join(",")}}`;
  const result = await getDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
    shortcode: string;
    title: string;
    subtitle: string | null;
    typeHint: string | null;
    aliases: string[] | null;
    keywords: string[] | null;
  }>(sql`
    WITH RECURSIVE location_path AS (
      SELECT l.id AS "rootId", l.id, l."parentId", l.name, 0 AS depth
      FROM "Location" l
      WHERE 'location' IN (${types})
        AND (${requestedIds}::text IS NULL OR l."id" IN (SELECT id FROM requested))
        AND l."deletedAt" IS NULL
      UNION ALL
      SELECT child."rootId", parent.id, parent."parentId", parent.name, child.depth + 1
      FROM "Location" parent
      JOIN location_path child ON child."parentId" = parent.id
      WHERE parent."deletedAt" IS NULL
    ), requested AS (
      SELECT unnest(${requestedIds}::uuid[]) AS id
    )
    SELECT * FROM (
      SELECT 'product'::text AS "entityType", p."id"::text AS "entityId", p."shortcode",
        p."name" AS title, p."manufacturer" AS subtitle, p."category" AS "typeHint",
        p."aliases" AS aliases, ARRAY[p."upc", p."model", p."manufacturer"]::text[] AS keywords
      FROM "Product" p WHERE p."deletedAt" IS NULL AND 'product' IN (${types}) AND (${requestedIds}::text IS NULL OR p."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'recipe', r."id"::text, r."shortcode", r."name", NULL, NULL, ARRAY[]::text[], ARRAY[]::text[]
      FROM "Recipe" r WHERE r."deletedAt" IS NULL AND 'recipe' IN (${types}) AND (${requestedIds}::text IS NULL OR r."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'ingredient', i."id"::text, i."shortcode", i."name", NULL, NULL, i."aliases", ARRAY[]::text[]
      FROM "Ingredient" i WHERE i."deletedAt" IS NULL AND i."recipeId" IS NULL AND 'ingredient' IN (${types}) AND (${requestedIds}::text IS NULL OR i."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'cookbook', c."id"::text, c."shortcode", c."name", NULLIF(array_to_string(c."author", ', '), ''), NULL, ARRAY[]::text[], c."subjects"
      FROM "Cookbook" c WHERE c."deletedAt" IS NULL AND 'cookbook' IN (${types}) AND (${requestedIds}::text IS NULL OR c."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'location', l."id"::text, l."shortcode", l."name",
        (SELECT string_agg(path.name, ' › ' ORDER BY path.depth DESC) FROM location_path path WHERE path."rootId" = l.id AND path.depth > 0),
        l."type", l."aliases", ARRAY[l."type"]::text[]
      FROM "Location" l WHERE l."deletedAt" IS NULL AND 'location' IN (${types}) AND (${requestedIds}::text IS NULL OR l."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'inventory', ie."id"::text, ie."shortcode", p."name", l."name", p."category", p."aliases", ARRAY[l."name", l."type", p."manufacturer", p."upc"]::text[]
      FROM "InventoryEntry" ie JOIN "Product" p ON p."id" = ie."productId" AND p."deletedAt" IS NULL JOIN "Location" l ON l."id" = ie."locationId" AND l."deletedAt" IS NULL
      WHERE ie."deletedAt" IS NULL AND 'inventory' IN (${types}) AND (${requestedIds}::text IS NULL OR ie."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'meal', m."id"::text, m."shortcode", COALESCE(NULLIF(m."name", ''), m."date"::text), m."date"::text, NULL, ARRAY[]::text[], ARRAY[m."date"::text]::text[]
      FROM "Meal" m WHERE m."deletedAt" IS NULL AND 'meal' IN (${types}) AND (${requestedIds}::text IS NULL OR m."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'project', p."id"::text, p."shortcode", p."name", concat_ws(' · ', p."kind", p."status"), p."icon", ARRAY[]::text[], ARRAY[p."kind", p."status"]::text[]
      FROM "Project" p WHERE p."deletedAt" IS NULL AND 'project' IN (${types}) AND (${requestedIds}::text IS NULL OR p."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'task', t."id"::text, t."shortcode", t."name", p."name", t."trade", ARRAY[]::text[], ARRAY[t."trade", sp."name"]::text[]
      FROM "Task" t LEFT JOIN "Project" p ON p."id" = t."projectId" AND p."deletedAt" IS NULL LEFT JOIN "Product" sp ON sp."id" = t."subjectProductId" AND sp."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL AND 'task' IN (${types}) AND (${requestedIds}::text IS NULL OR t."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'vendor', v."id"::text, v."shortcode", v."name", v."website", NULL, ARRAY[]::text[], ARRAY[v."website"]::text[]
      FROM "Vendor" v WHERE v."deletedAt" IS NULL AND 'vendor' IN (${types}) AND (${requestedIds}::text IS NULL OR v."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'purchase', pu."id"::text, pu."shortcode", COALESCE(NULLIF(pu."orderId", ''), v."name" || ' · ' || pu."date"::text), v."name", NULL, ARRAY[]::text[], ARRAY[pu."orderId", pu."displayLabel", v."name", v."website", pu."date"::text]::text[]
      FROM "Purchase" pu JOIN "Vendor" v ON v."id" = pu."vendorId" AND v."deletedAt" IS NULL
      WHERE pu."deletedAt" IS NULL AND 'purchase' IN (${types}) AND (${requestedIds}::text IS NULL OR pu."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'financialAccount', fa."id"::text, fa."shortcode", fa."name", fa."identity"->>'kind', fa."identity"->>'kind', ARRAY[]::text[],
        ARRAY(
          SELECT term
          FROM jsonb_array_elements(fa."sourceAliases") alias,
            LATERAL unnest(ARRAY[alias->>'source', alias->>'alias', alias->>'externalAccountId']) term
          WHERE term IS NOT NULL AND term <> ''
        )
      FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL AND 'financialAccount' IN (${types}) AND (${requestedIds}::text IS NULL OR fa."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'financialTransaction', ft."id"::text, ft."shortcode", COALESCE(NULLIF(ft."merchant", ''), NULLIF(ft."rawDescription", ''), ft."kind"), fa."name", ft."status", ARRAY[]::text[], ARRAY[ft."sourceCategory", ft."transactionDate"::text, ft."postedDate"::text]::text[]
      FROM "FinancialTransaction" ft JOIN "FinancialAccount" fa ON fa."id" = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE ft."deletedAt" IS NULL AND 'financialTransaction' IN (${types}) AND (${requestedIds}::text IS NULL OR ft."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'expense', e."id"::text, e."shortcode", e."name", p."name", CASE WHEN e."lineKind" = 'principal' THEN e."costType" ELSE e."lineKind" END, ARRAY[]::text[], ARRAY[e."lineKind", e."trade", e."costType"]::text[]
      FROM "Expense" e LEFT JOIN "Project" p ON p."id" = e."projectId" AND p."deletedAt" IS NULL
      WHERE e."deletedAt" IS NULL AND 'expense' IN (${types}) AND (${requestedIds}::text IS NULL OR e."id" IN (SELECT id FROM requested))
      UNION ALL
      SELECT 'wish', w."id"::text, w."shortcode", w."name", w."notes", 'tool wishlist', ARRAY[]::text[], ARRAY['tool wishlist']::text[]
      FROM "Wish" w WHERE w."deletedAt" IS NULL AND 'wish' IN (${types}) AND (${requestedIds}::text IS NULL OR w."id" IN (SELECT id FROM requested))
    ) source
  `);
  return result.rows.map((row) => ({
    ...row,
    aliases: textList(row.aliases ?? []),
    keywords: textList(row.keywords ?? []),
  }));
}

export async function refreshSearchDocument(
  db: Database,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchDocumentRefreshResult> {
  const [result] = await refreshSearchDocuments(db, [{ entityType, entityId }]);
  return result ?? (await markSearchDocumentMissing(db, entityType, entityId));
}

async function markSearchDocumentMissing(
  db: Database,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchDocumentRefreshResult> {
  await getDb(db).execute(sql`
    UPDATE "SearchDocument" SET "deletedAt" = now(), "updatedAt" = now()
    WHERE "entityType" = ${entityType} AND "entityId" = ${entityId}::uuid AND "deletedAt" IS NULL
  `);
  return { status: "missing", entityType, entityId };
}

async function upsertSearchDocumentBatch(
  db: Database,
  entries: ReadonlyArray<{ source: SearchDocumentSource; body: string }>,
): Promise<SearchDocumentRefreshResult[]> {
  if (entries.length === 0) return [];
  const rows = await Promise.all(
    entries.map(async ({ source, body }) => {
      const normalizedText = normalizeSearchText(source.title);
      const sourceHash = await hash(JSON.stringify({ ...source, body }));
      return sql`(
        ${source.entityType}::text, ${source.entityId}::uuid,
        ${source.shortcode}::text, ${source.title}::text,
        ${source.subtitle}::text, ${source.typeHint}::text,
        ${textArray(source.aliases)}, ${textArray(source.keywords)},
        ${body}::text, ${normalizedText}::text, ${sourceHash}::text
      )`;
    }),
  );
  await getDb(db).execute(sql`
    INSERT INTO "SearchDocument" (
      "entityType", "entityId", "shortcode", title, subtitle, "typeHint",
      aliases, keywords, body, "semanticText", "normalizedText",
      "searchVector", "sourceHash"
    )
    SELECT input."entityType", input."entityId", input.shortcode, input.title,
      input.subtitle, input."typeHint", input.aliases, input.keywords,
      input.body, input.body, input."normalizedText",
      setweight(to_tsvector('simple', input.title), 'A') ||
      setweight(to_tsvector('simple', concat_ws(' ', input.subtitle, array_to_string(input.aliases, ' '), array_to_string(input.keywords, ' '))), 'B') ||
      setweight(to_tsvector('simple', input.body), 'D'), input."sourceHash"
    FROM (VALUES ${sql.join(rows, sql`, `)}) AS input(
      "entityType", "entityId", shortcode, title, subtitle, "typeHint",
      aliases, keywords, body, "normalizedText", "sourceHash"
    )
    ON CONFLICT ("entityType", "entityId") WHERE "deletedAt" IS NULL DO UPDATE SET
      "shortcode" = EXCLUDED."shortcode", title = EXCLUDED.title,
      subtitle = EXCLUDED.subtitle, "typeHint" = EXCLUDED."typeHint",
      aliases = EXCLUDED.aliases, keywords = EXCLUDED.keywords,
      body = EXCLUDED.body, "semanticText" = EXCLUDED."semanticText",
      "normalizedText" = EXCLUDED."normalizedText",
      "searchVector" = EXCLUDED."searchVector",
      "sourceHash" = EXCLUDED."sourceHash", "updatedAt" = now(),
      "deletedAt" = NULL
  `);
  return entries.map(({ source }) => ({
    status: "upserted",
    entityType: source.entityType,
    entityId: source.entityId,
  }));
}

export async function refreshSearchDocuments(
  db: Database,
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<SearchDocumentRefreshResult[]> {
  if (refs.length === 0) return [];

  const idsByType = new Map<SearchableEntity, string[]>();
  for (const ref of refs) {
    const ids = idsByType.get(ref.entityType);
    if (ids) ids.push(ref.entityId);
    else idsByType.set(ref.entityType, [ref.entityId]);
  }

  // Two queries for the whole wave, not two per ref. The id set is passed
  // whole rather than per type: each UNION arm is already gated on its own
  // entity type, and ids are uuids, so an id belonging to another type simply
  // matches nothing in the arms it was not meant for.
  const [sources, texts] = await Promise.all([
    getSearchDocumentSources(
      db,
      [...idsByType.keys()],
      refs.map((ref) => ref.entityId),
    ),
    getEmbeddingTextsForRefs(db, idsByType),
  ]);

  const refKey = (entityType: SearchableEntity, entityId: string) =>
    `${entityType}:${entityId}`;
  const sourceByRef = new Map(
    sources.map((source) => [
      refKey(source.entityType, source.entityId),
      source,
    ]),
  );
  const textByRef = new Map(
    texts.map((text) => [refKey(text.entityType, text.entityId), text]),
  );

  const results: SearchDocumentRefreshResult[] = [];
  const entries: Array<{ source: SearchDocumentSource; body: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = refKey(ref.entityType, ref.entityId);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = sourceByRef.get(key);
    const text = textByRef.get(key);
    if (source && text) {
      entries.push({ source, body: text.embeddingText });
      continue;
    }
    results.push(
      await markSearchDocumentMissing(db, ref.entityType, ref.entityId),
    );
  }

  const batchSize = 250;
  for (let index = 0; index < entries.length; index += batchSize) {
    results.push(
      ...(await upsertSearchDocumentBatch(
        db,
        entries.slice(index, index + batchSize),
      )),
    );
  }
  return results;
}

export async function backfillSearchDocuments(
  db: Database,
  options: { entityTypes?: SearchableEntity[]; limit?: number } = {},
): Promise<SearchDocumentRefreshResult[]> {
  const entityTypes = options.entityTypes ?? [...searchableEntities];
  // This intentionally enumerates source rows through the canonical loaders,
  // not EntityEmbedding: a document backfill must heal a catalog whose vector
  // rows have never been configured, queued, or successfully embedded.
  const sourceRows = await getEmbeddingTextsForEntityTypes(
    db,
    entityTypes,
    options.limit,
  );
  const sources = await getSearchDocumentSources(db, entityTypes);
  const sourceByRef = new Map(
    sources.map((source) => [
      `${source.entityType}:${source.entityId}`,
      source,
    ]),
  );
  const results: SearchDocumentRefreshResult[] = [];
  const entries: Array<{ source: SearchDocumentSource; body: string }> = [];
  for (const row of sourceRows) {
    const source = sourceByRef.get(`${row.entityType}:${row.entityId}`);
    if (source) entries.push({ source, body: row.embeddingText });
    else
      results.push(
        await markSearchDocumentMissing(db, row.entityType, row.entityId),
      );
  }
  const batchSize = 250;
  for (let index = 0; index < entries.length; index += batchSize) {
    results.push(
      ...(await upsertSearchDocumentBatch(
        db,
        entries.slice(index, index + batchSize),
      )),
    );
  }
  if (options.limit == null) {
    const diagnostics = await getSearchDocumentDiagnostics(db, entityTypes);
    await retireOrphanedSearchDocuments(db, diagnostics.orphaned);
  }
  return results;
}

export async function getSearchDocumentEmbeddingText(
  db: Database,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchableEntityText | null> {
  const result = await getDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
    embeddingText: string;
  }>(sql`
    SELECT "entityType", "entityId"::text AS "entityId",
      "semanticText" AS "embeddingText"
    FROM "SearchDocument"
    WHERE "entityType" = ${entityType}
      AND "entityId" = ${entityId}::uuid
      AND "deletedAt" IS NULL
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

const STALE_DOCUMENT_SCAN_OVERSCAN = 4;

/** The embedding backfill worklist is derived from SearchDocument text. */
export async function getStaleSearchDocumentEmbeddingTexts(
  db: Database,
  entityTypes: SearchableEntity[],
  config: SemanticEmbeddingConfig,
  limit?: number,
): Promise<SearchableEntityText[]> {
  if (entityTypes.length === 0) return [];
  const scanLimit =
    limit == null
      ? sql``
      : sql`LIMIT ${Math.max(limit, limit * STALE_DOCUMENT_SCAN_OVERSCAN)}`;
  const result = await getDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
    embeddingText: string;
    embeddingHash: string | null;
  }>(sql`
    SELECT sd."entityType", sd."entityId"::text AS "entityId",
      sd."semanticText" AS "embeddingText", ee."embeddingHash"
    FROM "SearchDocument" sd
    LEFT JOIN "EntityEmbedding" ee
      ON ee."entityType" = sd."entityType"
      AND ee."entityId" = sd."entityId"
      AND ee.provider = ${config.provider}
      AND ee.model = ${config.model}
      AND ee.dimensions = ${config.dimensions}
      AND ee."deletedAt" IS NULL
    WHERE sd."deletedAt" IS NULL
      AND sd."entityType" IN (${sql.join(
        entityTypes.map((entityType) => sql`${entityType}`),
        sql`, `,
      )})
    ORDER BY sd."updatedAt" ASC, sd."entityType", sd."entityId"
    ${scanLimit}
  `);

  const stale: SearchableEntityText[] = [];
  for (const row of result.rows) {
    const expectedHash = await embeddingTextHash({
      entityType: row.entityType,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text: normalizeSearchText(row.embeddingText),
    });
    if (row.embeddingHash !== expectedHash) {
      stale.push({
        entityType: row.entityType,
        entityId: row.entityId,
        embeddingText: row.embeddingText,
      });
    }
    if (limit != null && stale.length >= limit) break;
  }
  return stale;
}

/** Missing, orphaned, and source-text-stale rows for cutover/repair checks. */
export async function getSearchDocumentDiagnostics(
  db: Database,
  entityTypes: SearchableEntity[] = [...searchableEntities],
): Promise<SearchDocumentDiagnostics> {
  const [sources, documentResult] = await Promise.all([
    getEmbeddingTextsForEntityTypes(db, entityTypes),
    getDb(db).execute<{
      entityType: SearchableEntity;
      entityId: string;
      semanticText: string;
    }>(sql`
      SELECT "entityType", "entityId"::text AS "entityId", "semanticText"
      FROM "SearchDocument"
      WHERE "deletedAt" IS NULL
        AND "entityType" IN (${sql.join(
          entityTypes.map((entityType) => sql`${entityType}`),
          sql`, `,
        )})
    `),
  ]);
  const sourceByRef = new Map(
    sources.map((source) => [
      `${source.entityType}:${source.entityId}`,
      source,
    ]),
  );
  const documentByRef = new Map(
    documentResult.rows.map((document) => [
      `${document.entityType}:${document.entityId}`,
      document,
    ]),
  );
  const missing = sources
    .filter(
      (source) => !documentByRef.has(`${source.entityType}:${source.entityId}`),
    )
    .map(({ entityType, entityId }) => ({ entityType, entityId }));
  const orphaned = documentResult.rows
    .filter(
      (document) =>
        !sourceByRef.has(`${document.entityType}:${document.entityId}`),
    )
    .map(({ entityType, entityId }) => ({ entityType, entityId }));
  const stale = documentResult.rows
    .filter((document) => {
      const source = sourceByRef.get(
        `${document.entityType}:${document.entityId}`,
      );
      return (
        source != null &&
        normalizeSearchText(source.embeddingText) !==
          normalizeSearchText(document.semanticText)
      );
    })
    .map(({ entityType, entityId }) => ({ entityType, entityId }));
  return { missing, orphaned, stale };
}

export async function retireOrphanedSearchDocuments(
  db: Database,
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<number> {
  if (refs.length === 0) return 0;
  const values = sql.join(
    refs.map((ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`),
    sql`, `,
  );
  const result = await getDb(db).execute<{ id: string }>(sql`
    WITH refs("entityType", "entityId") AS (VALUES ${values})
    UPDATE "SearchDocument" sd
    SET "deletedAt" = now(), "updatedAt" = now()
    FROM refs
    WHERE sd."entityType" = refs."entityType"
      AND sd."entityId" = refs."entityId"
      AND sd."deletedAt" IS NULL
    RETURNING sd.id::text AS id
  `);
  return result.rows.length;
}
