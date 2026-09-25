import { entityRefKey } from "@cubby/schemas/entity";
import {
  embeddableEntities,
  type SearchableEntity,
  type SearchableEntityRef,
  searchableEntities,
} from "@cubby/schemas/search";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { wasm } from "~/lib/wasm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { preferredImageDescriptionPolicy } from "~/server/image-processing/description-policy";
import { unwrapDb, uuidArrayParam } from "~/server/repo/database-helpers";
import {
  getEmbeddingTextsForRefs,
  type SearchableEntityText,
} from "~/server/repo/entity-embedding";
import { categorySummarySql } from "~/server/repo/product-category-sql";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { normalizeSearchText } from "~/server/semantic/text";

import { effectiveExpenseTradeSql } from "./expense-inheritance";
import { expenseProjectNamesSql } from "./expense-project-allocation";
import {
  effectiveProjectLocationsSql,
  effectiveTaskProjectSql,
  effectiveTaskSubjectProductSql,
  effectiveTaskTradeSql,
} from "./task-project-inheritance";

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

/**
 * Direct image attachment evidence is indexed with its owner only. The branch
 * list is generated from the canonical gallery bindings, so borrowed display
 * images and unrelated relationship traversal never leak into search text.
 */
async function loadDirectImageSearchText(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<Map<string, string>> {
  if (!refs.length) return new Map();
  const refValues = sql.join(
    refs.map((ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`),
    sql`, `,
  );
  const searchable = new Set<string>(searchableEntities);
  // Every direct attachment — gallery photo, cookbook cover, vendor logo — is
  // one EntityAttachment row; `refs` already limits it to searchable owners.
  const branches = [
    ...(searchable.has("image")
      ? [
          sql`SELECT 'image'::text AS "entityType", i.id::text AS "entityId", i.id AS "imageId"
          FROM "Image" i JOIN refs ON refs."entityType" = 'image' AND refs."entityId" = i.id
          WHERE i."deletedAt" IS NULL`,
        ]
      : []),
    sql`SELECT e."kind" AS "entityType", attachment."subjectEntityId"::text AS "entityId", attachment."imageId" AS "imageId"
        FROM "EntityAttachment" attachment
        JOIN "Entity" e ON e."id" = attachment."subjectEntityId"
        JOIN refs ON refs."entityType" = e."kind" AND refs."entityId" = attachment."subjectEntityId"
        WHERE attachment."deletedAt" IS NULL`,
  ];
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
    text: string | null;
  }>(sql`
    WITH refs("entityType", "entityId") AS (VALUES ${refValues}),
    attached AS (${sql.join(branches, sql` UNION ALL `)})
    SELECT attached."entityType", attached."entityId",
      COALESCE(correction.description, analysis.result->>'description') AS text
    FROM attached
    JOIN "Image" image ON image.id = attached."imageId" AND image."deletedAt" IS NULL
    LEFT JOIN LATERAL (
      SELECT c.description FROM "ImageDescriptionCorrection" c
      WHERE c."imageId" = image.id AND c."deletedAt" IS NULL
      LIMIT 1
    ) correction ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.result FROM "AiAnalysis" a
      WHERE a."entityType" = 'image' AND a."entityId" = image.id
        AND a.feature = 'image-description' AND a.provider = ${preferredImageDescriptionPolicy.provider}
        AND a.model = ${preferredImageDescriptionPolicy.model}
        AND a."promptVersion" = ${String(preferredImageDescriptionPolicy.promptRevision)}
        AND a."resultSchemaRevision" = ${preferredImageDescriptionPolicy.resultSchemaRevision}
        AND a."deletedAt" IS NULL
        AND CASE
          WHEN a."inputFingerprint" LIKE '{%'
          THEN a."inputFingerprint"::jsonb->>'sourceContentHash' = image.sha256
            AND a."inputFingerprint"::jsonb->>'provider' = ${preferredImageDescriptionPolicy.provider}
            AND a."inputFingerprint"::jsonb->>'model' = ${preferredImageDescriptionPolicy.model}
            AND a."inputFingerprint"::jsonb->>'promptRevision' = ${String(preferredImageDescriptionPolicy.promptRevision)}
            AND a."inputFingerprint"::jsonb->>'resultSchemaRevision' = ${String(preferredImageDescriptionPolicy.resultSchemaRevision)}
            AND a."inputFingerprint"::jsonb->>'normalizationRevision' = ${String(preferredImageDescriptionPolicy.normalizationRevision)}
          ELSE false
        END
      ORDER BY a."createdAt" DESC LIMIT 1
    ) analysis ON TRUE
  `);
  const values = new Map<string, string>();
  for (const row of result.rows) {
    const text = row.text?.trim();
    if (!text) continue;
    const key = entityRefKey(row.entityType, row.entityId);
    values.set(key, [values.get(key), text].filter(Boolean).join("\n"));
  }
  return values;
}

/**
 * Direct owners of one image, including the Image search document itself.
 * The generated gallery bindings are the only relationship source here, so
 * display fallbacks and borrowed images cannot become indexed evidence.
 */
export async function findDirectImageSearchOwnerRefs(
  db: Database | DrizzleTransaction,
  imageId: string,
): Promise<SearchableEntityRef[]> {
  const searchable = new Set<string>(searchableEntities);
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
  }>(sql`
    ${sql.join(
      [
        ...(searchable.has("image")
          ? [
              sql`SELECT 'image'::text AS "entityType", id::text AS "entityId" FROM "Image"
            WHERE id = ${imageId}::uuid AND "deletedAt" IS NULL`,
            ]
          : []),
        sql`SELECT e."kind" AS "entityType", attachment."subjectEntityId"::text AS "entityId"
          FROM "EntityAttachment" attachment
          JOIN "Entity" e ON e."id" = attachment."subjectEntityId" AND e."deletedAt" IS NULL
          WHERE attachment."imageId" = ${imageId}::uuid AND attachment."deletedAt" IS NULL`,
      ],
      sql` UNION ALL `,
    )}
  `);
  return result.rows.filter((row) => searchable.has(row.entityType));
}

/** Refresh docs and semantic work after an analysis/correction changes text. */
export async function refreshDirectImageOwnerSearchDocuments(
  db: Database,
  imageId: string,
): Promise<void> {
  const refs = await findDirectImageSearchOwnerRefs(db, imageId);
  await refreshCapturedImageSearchOwnerRefs(
    db,
    refs,
    "image-processing.search-text",
  );
}

/** Refresh image owners captured before an attachment edge is removed. */
export async function refreshCapturedImageSearchOwnerRefs(
  db: Database,
  refs: SearchableEntityRef[],
  source: string,
): Promise<void> {
  const { refreshDerivedSearchRefs } =
    await import("~/server/services/mutation-side-effects");
  await refreshDerivedSearchRefs(db, refs, source);
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
  db: Database | DrizzleTransaction,
  entityTypes: SearchableEntity[],
  entityIds?: readonly string[],
  page?: { cursor?: SearchDocumentCursor; pageSize?: number },
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
    image: sql`
      SELECT 'image'::text AS "entityType", i."id"::text AS "entityId", i."shortcode",
        i.filename AS title, NULL::text AS subtitle, 'image'::text AS "typeHint",
        ARRAY[]::text[] AS aliases, ARRAY[i."contentType"]::text[] AS keywords
      FROM "Image" i WHERE i."deletedAt" IS NULL AND 'image' IN (${types}) AND ${requested(sql`i."id"`)}`,
    product: sql`
      SELECT 'product'::text AS "entityType", p."id"::text AS "entityId", p."shortcode",
        p."name" AS title, p."manufacturer" AS subtitle, ${categorySummarySql(sql`p."categoryId"`)}->>'name' AS "typeHint",
        p."aliases" AS aliases,
        COALESCE((SELECT array_agg(pei."externalId") FROM "ProductExternalId" pei
                  WHERE pei."productId" = p."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL),
                 ARRAY[]::text[]) || ARRAY[p."model", p."manufacturer"]::text[] AS keywords
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
      SELECT 'inventory', ie."id"::text, ie."shortcode", p."name", l."name", ${categorySummarySql(sql`p."categoryId"`)}->>'name', p."aliases",
        ARRAY[l."name", l."type", p."manufacturer"]::text[] ||
        COALESCE((SELECT array_agg(pei."externalId") FROM "ProductExternalId" pei
                  WHERE pei."productId" = p."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL),
                 ARRAY[]::text[])
      FROM "InventoryEntry" ie JOIN "Product" p ON p."id" = ie."productId" AND p."deletedAt" IS NULL JOIN "Location" l ON l."id" = ie."locationId" AND l."deletedAt" IS NULL
      WHERE ie."deletedAt" IS NULL AND 'inventory' IN (${types}) AND ${requested(sql`ie."id"`)}`,
    meal: sql`
      SELECT 'meal', m."id"::text, m."shortcode", COALESCE(NULLIF(m."name", ''), m."date"::text), m."date"::text, NULL, ARRAY[]::text[], ARRAY[m."date"::text]::text[]
      FROM "Meal" m WHERE m."deletedAt" IS NULL AND 'meal' IN (${types}) AND ${requested(sql`m."id"`)}`,
    project: sql`
      SELECT 'project', p."id"::text, p."shortcode", p."name", concat_ws(' · ', p."kind", p."status"), p."icon", ARRAY[]::text[], ARRAY[p."kind", p."status"]::text[] || ${effectiveProjectLocationsSql(sql`p."id"`)}
      FROM "Project" p WHERE p."deletedAt" IS NULL AND 'project' IN (${types}) AND ${requested(sql`p."id"`)}`,
    task: sql`
      SELECT 'task', t."id"::text, t."shortcode", t."name", p."name", ${effectiveTaskTradeSql("t")}, ARRAY[]::text[], ARRAY[${effectiveTaskTradeSql("t")}, sp."name"]::text[]
      FROM "Task" t LEFT JOIN "Project" p ON p."id" = ${effectiveTaskProjectSql("t")} AND p."deletedAt" IS NULL LEFT JOIN "Product" sp ON sp."id" = ${effectiveTaskSubjectProductSql("t")} AND sp."deletedAt" IS NULL
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
        ) || ARRAY(
          SELECT card->>'last4' FROM jsonb_array_elements(fa."cardNumbers") card
        )
      FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL AND 'financialAccount' IN (${types}) AND ${requested(sql`fa."id"`)}`,
    financialTransaction: sql`
      SELECT 'financialTransaction', ft."id"::text, ft."shortcode", COALESCE(NULLIF(ft."merchant", ''), NULLIF(ft."rawDescription", ''), ft."kind"), fa."name", ft."status", ARRAY[]::text[], ARRAY[ft."sourceCategory", ft."transactionDate"::text, ft."postedDate"::text]::text[]
      FROM "FinancialTransaction" ft JOIN "FinancialAccount" fa ON fa."id" = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE ft."deletedAt" IS NULL AND 'financialTransaction' IN (${types}) AND ${requested(sql`ft."id"`)}`,
    expense: sql`
      SELECT 'expense', e."id"::text, e."shortcode", e."name", ${expenseProjectNamesSql(sql`e."id"`)}, CASE WHEN e."lineKind" = 'principal' THEN e."costType" ELSE e."lineKind" END, ARRAY[]::text[], ARRAY[e."lineKind", ${effectiveExpenseTradeSql("e")}, e."costType"]::text[]
      FROM "Expense" e
      WHERE e."deletedAt" IS NULL AND 'expense' IN (${types}) AND ${requested(sql`e."id"`)}`,
    wish: sql`
      SELECT 'wish', w."id"::text, w."shortcode", w."name", w."notes", 'tool wishlist', ARRAY[]::text[], ARRAY['tool wishlist']::text[]
      FROM "Wish" w WHERE w."deletedAt" IS NULL AND 'wish' IN (${types}) AND ${requested(sql`w."id"`)}`,
    // The crop label lives in static data, not SQL, so the title is the plant
    // name and the crop key rides along as a search term.
    plant: sql`
      SELECT 'plant', p."id"::text, p."shortcode", p."name",
        concat_ws(' · ', p."gardenGuideKey", p."verdict"), p."verdict",
        ARRAY[]::text[], ARRAY[p."gardenGuideKey", p."latinName"]::text[]
      FROM "Plant" p
      WHERE p."deletedAt" IS NULL AND 'plant' IN (${types}) AND ${requested(sql`p."id"`)}`,
    // Title is the plant name (see `plant` above for why not its crop label).
    planting: sql`
      SELECT 'planting', pl."id"::text, pl."shortcode",
        COALESCE(p."name", 'Unknown plant'),
        concat_ws(' · ', pl."status", l."name"), pl."status",
        ARRAY[]::text[], ARRAY[p."gardenGuideKey", l."name"]::text[]
      FROM "Planting" pl
      LEFT JOIN "Plant" p ON p."id" = pl."plantId" AND p."deletedAt" IS NULL
      LEFT JOIN "Location" l ON l."id" = pl."locationId" AND l."deletedAt" IS NULL
      WHERE pl."deletedAt" IS NULL AND 'planting' IN (${types}) AND ${requested(sql`pl."id"`)}`,
    // Title mirrors `gardenEntryDisplayName` (garden/index.ts): kind label ·
    // observed date · location name. Subtitle is the comma-separated set of
    // live linked planting display names.  The correlated aggregate keeps the
    // source projection one row per GardenEntry even when an entry names many
    // plantings.
    gardenEntry: sql`
      SELECT 'gardenEntry', ge."id"::text, ge."shortcode",
        (CASE ge."kind" WHEN 'observation' THEN 'Note' WHEN 'harvest' THEN 'Harvest' ELSE 'Move' END)
          || ' · ' || to_char(ge."observedOn", 'YYYY-MM-DD') || ' · ' || l."name",
        (SELECT string_agg(COALESCE(p."name", 'Unknown plant'), ', ' ORDER BY pl."shortcode")
         FROM "GardenEntryPlanting" gep
         JOIN "Planting" pl ON pl."id" = gep."plantingId" AND pl."deletedAt" IS NULL
         LEFT JOIN "Plant" p ON p."id" = pl."plantId" AND p."deletedAt" IS NULL
         WHERE gep."gardenEntryId" = ge."id" AND gep."deletedAt" IS NULL),
        ge."kind", ARRAY[]::text[], ARRAY[l."name", ge."harvestAmount"]::text[]
      FROM "GardenEntry" ge
      JOIN "Location" l ON l."id" = ge."locationId" AND l."deletedAt" IS NULL
      WHERE ge."deletedAt" IS NULL AND 'gardenEntry' IN (${types}) AND ${requested(sql`ge."id"`)}`,
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

  const cursor = page?.cursor
    ? sql`WHERE (source."entityType", source."entityId"::uuid) > (${page.cursor.entityType}, ${page.cursor.entityId}::uuid)`
    : sql``;
  const limit = page?.pageSize ? sql`LIMIT ${page.pageSize}` : sql``;
  const result = await unwrapDb(db).execute<{
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
    ${cursor}
    ORDER BY source."entityType", source."entityId"::uuid
    ${limit}
  `);
  return result.rows.map((row) => {
    const keywords = textList(row.keywords ?? []);
    return {
      ...row,
      aliases: textList(row.aliases ?? []),
      keywords:
        row.entityType === "product" || row.entityType === "inventory"
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
  options: { cursor?: SearchDocumentCursor; pageSize?: number } = {},
): Promise<{
  refs: Array<{ entityType: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
}> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 250, 1), 250);
  const cursor = options.cursor
    ? sql`AND ("entityType", "entityId") > (${options.cursor.entityType}, ${options.cursor.entityId}::uuid)`
    : sql``;
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
  }>(sql`
    SELECT "entityType", "entityId"::text AS "entityId"
    FROM "SearchDocument"
    WHERE "deletedAt" IS NULL ${cursor}
    ORDER BY "entityType", "entityId"
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
  entityTypes: SearchableEntity[],
  options: { cursor?: SearchDocumentCursor; pageSize?: number } = {},
): Promise<{
  refs: Array<{ entityType: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
  scannedCount: number;
  missingCount: number;
  staleCount: number;
}> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 250, 1), 250);
  const sources = await getSearchDocumentSources(db, entityTypes, undefined, {
    cursor: options.cursor,
    pageSize,
  });
  const idsByType = new Map<SearchableEntity, string[]>();
  for (const source of sources) {
    idsByType.set(source.entityType, [
      ...(idsByType.get(source.entityType) ?? []),
      source.entityId,
    ]);
  }
  const [texts, documents] = await Promise.all([
    getEmbeddingTextsForRefs(db, idsByType),
    unwrapDb(db).execute<{
      entityType: SearchableEntity;
      entityId: string;
      sourceHash: string;
    }>(sql`
      SELECT "entityType", "entityId"::text AS "entityId", "sourceHash"
      FROM "SearchDocument"
      WHERE "deletedAt" IS NULL
        AND "entityId" = ANY(${uuidArrayParam(sources.map((source) => source.entityId))})
    `),
  ]);
  const imageTexts = await loadDirectImageSearchText(
    db,
    sources.map((source) => ({
      entityType: source.entityType,
      entityId: source.entityId,
    })),
  );
  const textByRef = new Map(
    texts.map((text) => [entityRefKey(text.entityType, text.entityId), text]),
  );
  const documentByRef = new Map(
    documents.rows.map((document) => [
      entityRefKey(document.entityType, document.entityId),
      document,
    ]),
  );
  const refs: Array<{ entityType: SearchableEntity; entityId: string }> = [];
  for (const source of sources) {
    const key = entityRefKey(source.entityType, source.entityId);
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
      refs.push({ entityType: source.entityType, entityId: source.entityId });
    }
  }
  const last = sources.at(-1);
  return {
    refs,
    nextCursor:
      last && sources.length === pageSize
        ? { entityType: last.entityType, entityId: last.entityId }
        : null,
    scannedCount: sources.length,
    missingCount: refs.filter(
      (ref) => !documentByRef.has(entityRefKey(ref.entityType, ref.entityId)),
    ).length,
    staleCount: refs.filter((ref) =>
      documentByRef.has(entityRefKey(ref.entityType, ref.entityId)),
    ).length,
  };
}

export async function getSearchDocumentOrphanPage(
  db: Database | DrizzleTransaction,
  options: { cursor?: SearchDocumentCursor; pageSize?: number } = {},
): Promise<{
  refs: Array<{ entityType: SearchableEntity; entityId: string }>;
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
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<Array<{ entityType: SearchableEntity; entityId: string }>> {
  if (refs.length === 0) return [];
  const idsByType = new Map<SearchableEntity, string[]>();
  for (const ref of refs)
    idsByType.set(ref.entityType, [
      ...(idsByType.get(ref.entityType) ?? []),
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
    sources.map((source) => entityRefKey(source.entityType, source.entityId)),
  );
  const textRefs = new Set(
    texts.map((text) => entityRefKey(text.entityType, text.entityId)),
  );
  return refs.filter((ref) => {
    const key = entityRefKey(ref.entityType, ref.entityId);
    return !sourceRefs.has(key) || !textRefs.has(key);
  });
}

export async function refreshSearchDocument(
  db: Database | DrizzleTransaction,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchDocumentRefreshResult> {
  const [result] = await refreshSearchDocuments(db, [{ entityType, entityId }]);
  return result ?? (await markSearchDocumentMissing(db, entityType, entityId));
}

async function markSearchDocumentMissing(
  db: Database | DrizzleTransaction,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchDocumentRefreshResult> {
  await unwrapDb(db).execute(sql`
    UPDATE "SearchDocument" SET "deletedAt" = now(), "updatedAt" = now()
    WHERE "entityType" = ${entityType} AND "entityId" = ${entityId}::uuid AND "deletedAt" IS NULL
  `);
  return { status: "missing", entityType, entityId };
}

async function upsertSearchDocumentBatch(
  db: Database | DrizzleTransaction,
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
  await unwrapDb(db).execute(sql`
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
  db: Database | DrizzleTransaction,
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
      entries.push({
        source,
        body: [text.embeddingText, imageTexts.get(key)]
          .filter((value): value is string => Boolean(value))
          .join("\n"),
      });
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
  db: Database | DrizzleTransaction,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchableEntityText | null> {
  const result = await unwrapDb(db).execute<{
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

/**
 * The embedding bodies for a whole wave of refs in one round trip.
 *
 * Shaped like `hydrateSearchHitRefs`: a VALUES-joined ref table rather than an
 * `IN` list, so the pair `(entityType, entityId)` is matched as a pair and the
 * result comes back in the caller's own order. Refs with no live document are
 * simply absent — the batch embedding path treats that as nothing to embed,
 * exactly as the single-ref loader's `null` does.
 */
export async function getSearchDocumentEmbeddingTexts(
  db: Database | DrizzleTransaction,
  refs: ReadonlyArray<{ entityType: SearchableEntity; entityId: string }>,
): Promise<SearchableEntityText[]> {
  if (refs.length === 0) return [];
  const values = sql.join(
    refs.map(
      (ref, index) =>
        sql`(${ref.entityType}::text, ${ref.entityId}::uuid, ${index}::integer)`,
    ),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
    embeddingText: string;
  }>(sql`
    WITH refs("entityType", "entityId", ordinal) AS (VALUES ${values})
    SELECT sd."entityType", sd."entityId"::text AS "entityId",
      sd."semanticText" AS "embeddingText"
    FROM refs
    JOIN "SearchDocument" sd
      ON sd."entityType" = refs."entityType"
      AND sd."entityId" = refs."entityId"
      AND sd."deletedAt" IS NULL
    ORDER BY refs.ordinal
  `);
  return result.rows;
}

const SEARCH_DOCUMENT_WORKFLOW_PAGE_SIZE = 250;

/**
 * The SQL twin of `normalizeSearchText` (trim, collapse whitespace, lowercase),
 * so "is this document's vector current?" can be answered inside Postgres
 * without shipping every body to JS to hash. Equal normalized texts hash equal.
 */
const normalizedTextSql = (column: SQL): SQL =>
  sql`lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;

// Bound as individual parameters, joined by a literal comma — never a JS
// array interpolated directly into `IN (...)`, which drizzle would render as
// a row constructor rather than a list (the `no-unsafe-sql-array-interpolation`
// Oxlint rule guards this).
const embeddableEntityTypesSql = sql.join(
  embeddableEntities.map((entityType) => sql`${entityType}`),
  sql`, `,
);

/**
 * Live, embeddable documents whose configured vector is missing or was
 * computed from different text. Restricted to `embeddableEntities`: the
 * three financial entities are searchable but never get an `EntityEmbedding`
 * row (see `entity-manifest.ts`), so without this filter they would show up
 * here forever. This predicate is shared by the awaiting-work count, the
 * "Settle now" selection, and the cron assertion so they cannot disagree.
 */
const unembeddedDocumentsSql = (config: SemanticEmbeddingConfig): SQL => sql`
  FROM "SearchDocument" sd
  LEFT JOIN "EntityEmbedding" ee
    ON ee."entityType" = sd."entityType"
    AND ee."entityId" = sd."entityId"
    AND ee.provider = ${config.provider}
    AND ee.model = ${config.model}
    AND ee.dimensions = ${config.dimensions}
    AND ee."deletedAt" IS NULL
  WHERE sd."deletedAt" IS NULL
    AND sd."entityType" IN (${embeddableEntityTypesSql})
    AND (ee.id IS NULL
      OR ${normalizedTextSql(sql`ee."embeddingText"`)} <> ${normalizedTextSql(sql`sd."semanticText"`)})
`;

export async function countUnembeddedSearchDocuments(
  db: Database | DrizzleTransaction,
  config: SemanticEmbeddingConfig,
): Promise<number> {
  const result = await unwrapDb(db).execute<{ count: number }>(sql`
    SELECT count(*)::int AS count ${unembeddedDocumentsSql(config)}
  `);
  return result.rows[0]?.count ?? 0;
}

/** One keyset page of unembedded refs, for publishing refresh tasks. */
export async function selectUnembeddedSearchDocumentRefs(
  db: Database | DrizzleTransaction,
  config: SemanticEmbeddingConfig,
  options: { cursor?: SearchDocumentCursor; pageSize?: number } = {},
): Promise<{
  refs: Array<{ entityType: SearchableEntity; entityId: string }>;
  nextCursor: SearchDocumentCursor | null;
}> {
  const pageSize = Math.min(
    Math.max(options.pageSize ?? SEARCH_DOCUMENT_WORKFLOW_PAGE_SIZE, 1),
    SEARCH_DOCUMENT_WORKFLOW_PAGE_SIZE,
  );
  const cursor = options.cursor
    ? sql`AND (sd."entityType", sd."entityId") > (${options.cursor.entityType}, ${options.cursor.entityId}::uuid)`
    : sql``;
  const result = await unwrapDb(db).execute<{
    entityType: SearchableEntity;
    entityId: string;
  }>(sql`
    SELECT sd."entityType", sd."entityId"::text AS "entityId"
    ${unembeddedDocumentsSql(config)}
    ${cursor}
    ORDER BY sd."entityType", sd."entityId"
    LIMIT ${pageSize}
  `);
  const last = result.rows.at(-1);
  return {
    refs: result.rows,
    nextCursor:
      last && result.rows.length === pageSize
        ? { entityType: last.entityType, entityId: last.entityId }
        : null,
  };
}

export type SearchDocumentCursor = {
  entityType: SearchableEntity;
  entityId: string;
};
