import { entityRefKey } from "@cubby/schemas/entity";
import {
  type SearchableEntity,
  searchableEntities,
} from "@cubby/schemas/search";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb, uuidArrayParam } from "~/server/repo/database-helpers";
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

/**
 * The identity of a written row: every projected column plus the semantic body.
 *
 * The writer and the staleness check deliberately share this one function.
 * Spelling the comparison out field by field would leave a rule that quietly
 * stops covering whatever column is added to `SearchDocumentSource` next, and
 * comparing the semantic body alone covers a projected column only where that
 * column happens to also appear in the embedding text — `project.icon` never
 * does, and a `typeHint` outliving its enum is exactly the drift that hides
 * there (#750 narrowed the location enum and nothing re-projected the 100
 * documents still carrying a retired value).
 */
async function searchDocumentSourceHash(
  source: SearchDocumentSource,
  body: string,
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ ...source, body })),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  // literal bound as text and cast in SQL, via the only constructor the
  // `hand-rolled-any-array` guard accepts. It is deliberately NOT a JS array
  // interpolated into `sql` — drizzle renders that as a row constructor — and
  // not `eqAny`/`inArray`, which emit `IN ($1, …, $n)`: this is raw SQL over
  // fifteen aliased tables, and a parameter per id is the cost being removed.
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

  // One branch per searchable entity, `satisfies Record<SearchableEntity, SQL>`
  // so the compiler — not a reviewer — is what notices a new `searchable: true`
  // entity. Without it the new entity still gets a `searchDocumentBuilders`
  // entry (also exhaustive) and still passes every type check, while its branch
  // is simply absent from the union: `getSearchDocumentSource` returns null,
  // `refreshSearchDocument` marks the document missing forever, and the entity
  // never appears in global search. Nothing else in the pipeline sees that hole.
  const branches = {
    product: sql`
      SELECT 'product'::text AS "entityType", p."id"::text AS "entityId", p."shortcode",
        p."name" AS title, p."manufacturer" AS subtitle, p."category" AS "typeHint",
        p."aliases" AS aliases, ARRAY[p."upc", p."model", p."manufacturer"]::text[] AS keywords
      FROM "Product" p WHERE p."deletedAt" IS NULL AND 'product' IN (${types}) AND ${requested(sql`p."id"`)}`,
    recipe: sql`
      SELECT 'recipe', r."id"::text, r."shortcode", r."name", NULL, NULL, ARRAY[]::text[], ARRAY[]::text[]
      FROM "Recipe" r WHERE r."deletedAt" IS NULL AND 'recipe' IN (${types}) AND ${requested(sql`r."id"`)}`,
    ingredient: sql`
      SELECT 'ingredient', i."id"::text, i."shortcode", i."name", NULL, NULL, i."aliases", ARRAY[]::text[]
      FROM "Ingredient" i WHERE i."deletedAt" IS NULL AND i."recipeId" IS NULL AND 'ingredient' IN (${types}) AND ${requested(sql`i."id"`)}`,
    cookbook: sql`
      SELECT 'cookbook', c."id"::text, c."shortcode", c."name", NULLIF(array_to_string(c."author", ', '), ''), NULL, ARRAY[]::text[], c."subjects"
      FROM "Cookbook" c WHERE c."deletedAt" IS NULL AND 'cookbook' IN (${types}) AND ${requested(sql`c."id"`)}`,
    location: sql`
      SELECT 'location', l."id"::text, l."shortcode", l."name",
        (SELECT string_agg(path.name, ' › ' ORDER BY path.depth DESC) FROM location_path path WHERE path."rootId" = l.id AND path.depth > 0),
        l."type", l."aliases", ARRAY[l."type"]::text[]
      FROM "Location" l WHERE l."deletedAt" IS NULL AND 'location' IN (${types}) AND ${requested(sql`l."id"`)}`,
    inventory: sql`
      SELECT 'inventory', ie."id"::text, ie."shortcode", p."name", l."name", p."category", p."aliases", ARRAY[l."name", l."type", p."manufacturer", p."upc"]::text[]
      FROM "InventoryEntry" ie JOIN "Product" p ON p."id" = ie."productId" AND p."deletedAt" IS NULL JOIN "Location" l ON l."id" = ie."locationId" AND l."deletedAt" IS NULL
      WHERE ie."deletedAt" IS NULL AND 'inventory' IN (${types}) AND ${requested(sql`ie."id"`)}`,
    meal: sql`
      SELECT 'meal', m."id"::text, m."shortcode", COALESCE(NULLIF(m."name", ''), m."date"::text), m."date"::text, NULL, ARRAY[]::text[], ARRAY[m."date"::text]::text[]
      FROM "Meal" m WHERE m."deletedAt" IS NULL AND 'meal' IN (${types}) AND ${requested(sql`m."id"`)}`,
    project: sql`
      SELECT 'project', p."id"::text, p."shortcode", p."name", concat_ws(' · ', p."kind", p."status"), p."icon", ARRAY[]::text[], ARRAY[p."kind", p."status"]::text[]
      FROM "Project" p WHERE p."deletedAt" IS NULL AND 'project' IN (${types}) AND ${requested(sql`p."id"`)}`,
    task: sql`
      SELECT 'task', t."id"::text, t."shortcode", t."name", p."name", t."trade", ARRAY[]::text[], ARRAY[t."trade", sp."name"]::text[]
      FROM "Task" t LEFT JOIN "Project" p ON p."id" = t."projectId" AND p."deletedAt" IS NULL LEFT JOIN "Product" sp ON sp."id" = t."subjectProductId" AND sp."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL AND 'task' IN (${types}) AND ${requested(sql`t."id"`)}`,
    vendor: sql`
      SELECT 'vendor', v."id"::text, v."shortcode", v."name", v."website", NULL, ARRAY[]::text[], ARRAY[v."website"]::text[]
      FROM "Vendor" v WHERE v."deletedAt" IS NULL AND 'vendor' IN (${types}) AND ${requested(sql`v."id"`)}`,
    purchase: sql`
      SELECT 'purchase', pu."id"::text, pu."shortcode", COALESCE(NULLIF(pu."orderId", ''), v."name" || ' · ' || pu."date"::text), v."name", NULL, ARRAY[]::text[], ARRAY[pu."orderId", pu."displayLabel", v."name", v."website", pu."date"::text]::text[]
      FROM "Purchase" pu JOIN "Vendor" v ON v."id" = pu."vendorId" AND v."deletedAt" IS NULL
      WHERE pu."deletedAt" IS NULL AND 'purchase' IN (${types}) AND ${requested(sql`pu."id"`)}`,
    financialAccount: sql`
      SELECT 'financialAccount', fa."id"::text, fa."shortcode", fa."name", fa."identity"->>'kind', fa."identity"->>'kind', ARRAY[]::text[],
        ARRAY(
          SELECT term
          FROM jsonb_array_elements(fa."sourceAliases") alias,
            LATERAL unnest(ARRAY[alias->>'source', alias->>'alias', alias->>'externalAccountId']) term
          WHERE term IS NOT NULL AND term <> ''
        )
      FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL AND 'financialAccount' IN (${types}) AND ${requested(sql`fa."id"`)}`,
    financialTransaction: sql`
      SELECT 'financialTransaction', ft."id"::text, ft."shortcode", COALESCE(NULLIF(ft."merchant", ''), NULLIF(ft."rawDescription", ''), ft."kind"), fa."name", ft."status", ARRAY[]::text[], ARRAY[ft."sourceCategory", ft."transactionDate"::text, ft."postedDate"::text]::text[]
      FROM "FinancialTransaction" ft JOIN "FinancialAccount" fa ON fa."id" = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE ft."deletedAt" IS NULL AND 'financialTransaction' IN (${types}) AND ${requested(sql`ft."id"`)}`,
    expense: sql`
      SELECT 'expense', e."id"::text, e."shortcode", e."name", p."name", CASE WHEN e."lineKind" = 'principal' THEN e."costType" ELSE e."lineKind" END, ARRAY[]::text[], ARRAY[e."lineKind", e."trade", e."costType"]::text[]
      FROM "Expense" e LEFT JOIN "Project" p ON p."id" = e."projectId" AND p."deletedAt" IS NULL
      WHERE e."deletedAt" IS NULL AND 'expense' IN (${types}) AND ${requested(sql`e."id"`)}`,
    wish: sql`
      SELECT 'wish', w."id"::text, w."shortcode", w."name", w."notes", 'tool wishlist', ARRAY[]::text[], ARRAY['tool wishlist']::text[]
      FROM "Wish" w WHERE w."deletedAt" IS NULL AND 'wish' IN (${types}) AND ${requested(sql`w."id"`)}`,
  } satisfies Record<SearchableEntity, SQL>;

  // Postgres takes a UNION's column NAMES and TYPES from its FIRST branch, and
  // `product` is the only branch that spells the aliases (and the only one
  // whose `typeHint` is a real enum column). It therefore leads explicitly,
  // rather than by whatever order this record or the manifest happens to have.
  const { product: productBranch, ...otherBranches } = branches;
  const union = sql.join(
    [productBranch, ...Object.values(otherBranches)],
    sql` UNION ALL `,
  );

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
        AND ${requested(sql`l."id"`)}
        AND l."deletedAt" IS NULL
      UNION ALL
      SELECT child."rootId", parent.id, parent."parentId", parent.name, child.depth + 1
      FROM "Location" parent
      JOIN location_path child ON child."parentId" = parent.id
      WHERE parent."deletedAt" IS NULL
    )
    SELECT * FROM (${union}) source
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
      const sourceHash = await searchDocumentSourceHash(source, body);
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

  const sourceByRef = new Map(
    sources.map((source) => [
      entityRefKey(source.entityType, source.entityId),
      source,
    ]),
  );
  const textByRef = new Map(
    texts.map((text) => [entityRefKey(text.entityType, text.entityId), text]),
  );

  const results: SearchDocumentRefreshResult[] = [];
  const entries: Array<{ source: SearchDocumentSource; body: string }> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = entityRefKey(ref.entityType, ref.entityId);
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

/**
 * Missing, orphaned, and stale rows for cutover/repair checks.
 *
 * Staleness is the whole written row against the whole live one, via
 * `sourceHash` — not the semantic body against itself. Nothing in this
 * codebase re-projects `SearchDocument` when a projection or an enum changes:
 * documents are refreshed per entity by `runMutationSideEffects`, and the two
 * paths that skip it — a raw-SQL backfill script, a `db:push` that reinterprets
 * a column — are exactly the ones that change a projection wholesale. This
 * check plus `repairSearchDocuments` is that missing trigger, so it has to see
 * every projected column rather than the subset the embedding text echoes.
 */
export async function getSearchDocumentDiagnostics(
  db: Database,
  entityTypes: SearchableEntity[] = [...searchableEntities],
): Promise<SearchDocumentDiagnostics> {
  // Texts enumerate what SHOULD exist (the canonical loaders, as the backfill
  // uses); sources carry the projected columns the write path hashes.
  const [texts, sources, documentResult] = await Promise.all([
    getEmbeddingTextsForEntityTypes(db, entityTypes),
    getSearchDocumentSources(db, entityTypes),
    getDb(db).execute<{
      entityType: SearchableEntity;
      entityId: string;
      sourceHash: string;
    }>(sql`
      SELECT "entityType", "entityId"::text AS "entityId", "sourceHash"
      FROM "SearchDocument"
      WHERE "deletedAt" IS NULL
        AND "entityType" IN (${sql.join(
          entityTypes.map((entityType) => sql`${entityType}`),
          sql`, `,
        )})
    `),
  ]);
  const textByRef = new Map(
    texts.map((text) => [entityRefKey(text.entityType, text.entityId), text]),
  );
  const sourceByRef = new Map(
    sources.map((source) => [
      entityRefKey(source.entityType, source.entityId),
      source,
    ]),
  );
  const documentByRef = new Map(
    documentResult.rows.map((document) => [
      entityRefKey(document.entityType, document.entityId),
      document,
    ]),
  );
  const missing = texts
    .filter(
      (text) =>
        !documentByRef.has(entityRefKey(text.entityType, text.entityId)),
    )
    .map(({ entityType, entityId }) => ({ entityType, entityId }));
  const orphaned = documentResult.rows
    .filter(
      (document) =>
        !textByRef.has(entityRefKey(document.entityType, document.entityId)),
    )
    .map(({ entityType, entityId }) => ({ entityType, entityId }));

  const stale: Array<{ entityType: SearchableEntity; entityId: string }> = [];
  for (const document of documentResult.rows) {
    const key = entityRefKey(document.entityType, document.entityId);
    const source = sourceByRef.get(key);
    const text = textByRef.get(key);
    // No live source is orphaned, not stale — reported above, retired by repair.
    if (!source || !text) continue;
    const expected = await searchDocumentSourceHash(source, text.embeddingText);
    if (expected !== document.sourceHash) {
      stale.push({
        entityType: document.entityType,
        entityId: document.entityId,
      });
    }
  }
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
