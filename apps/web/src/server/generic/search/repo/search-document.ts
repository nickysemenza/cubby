import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { entityRefKey, entitySchema } from "@cubby/schemas/entity";
import { gardenEntryKind } from "@cubby/schemas/garden-fields";
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
import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { categorySummarySql } from "~/server/db/computed/product-category-sql";
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
import { expenseDerivedReadSql } from "~/server/domains/expense/repo/expense-derived-read";
import { effectiveExpenseTradeSql } from "~/server/domains/expense/repo/expense-inheritance";
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
  const searchable = new Set<string>(searchableEntities);
  // Every direct attachment — gallery photo, cookbook cover, vendor logo — is
  // one EntityAttachment row; `refs` already limits it to searchable owners.
  const branches = [
    ...(searchable.has("image")
      ? [
          sql`SELECT 'image'::text AS "entityKind", i.id::text AS "entityId", i.id AS "imageId"
          FROM "Image" i JOIN refs ON refs."entityKind" = 'image' AND refs."entityId" = i.id
          WHERE i."deletedAt" IS NULL`,
        ]
      : []),
    sql`SELECT e."kind" AS "entityKind", attachment."entityId"::text AS "entityId", attachment."imageId" AS "imageId"
        FROM "EntityAttachment" attachment
        JOIN "Entity" e ON e."id" = attachment."entityId"
        JOIN refs ON refs."entityKind" = e."kind" AND refs."entityId" = attachment."entityId"
        WHERE attachment."deletedAt" IS NULL`,
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
    JOIN "Image" image ON image.id = attached."imageId" AND image."deletedAt" IS NULL
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

function searchDocumentSourceSql(
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

  const expenseNameIds = entityIds
    ? uuidArrayParam(entityIds)
    : page?.pageSize
      ? sql`ARRAY(SELECT name_source.id FROM "Expense" name_source
      WHERE name_source."deletedAt" IS NULL AND ${bounded(sql`name_source."createdAt"`)}
      ${page.cursor ? sql`AND (${entitySchema.enum.expense}::text, name_source.id) > (${page.cursor.entityKind}, ${page.cursor.entityId}::uuid)` : sql``}
      ORDER BY name_source.id LIMIT ${page.pageSize})`
      : undefined;

  // Exhaustive builders make newly searchable kinds a compiler obligation;
  // a missing source must not silently become a permanently missing document.
  const branches = {
    image: () => sql`
      SELECT 'image'::text AS "entityKind", i."id"::text AS "entityId", i."shortcode",
        i.filename AS title, NULL::text AS subtitle, 'image'::text AS "typeHint",
        ARRAY[]::text[] AS aliases, ARRAY[i."contentType"]::text[] AS keywords
      FROM "Image" i WHERE i."deletedAt" IS NULL AND 'image' IN (${types}) AND ${requested(sql`i."id"`)} AND ${bounded(sql`i."createdAt"`)}`,
    product: () => sql`
      SELECT 'product'::text AS "entityKind", p."id"::text AS "entityId", p."shortcode",
        p."name" AS title, ${productBrandNameSql(sql`p."brandId"`)} AS subtitle, ${categorySummarySql(sql`p."categoryId"`)}->>'name' AS "typeHint",
        p."aliases" AS aliases,
        COALESCE((SELECT array_agg(pei."externalId") FROM "EntityExternalId" pei
                  WHERE pei."entityId" = p."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL),
                 ARRAY[]::text[]) || ARRAY[p."model", ${productBrandNameSql(sql`p."brandId"`)}]::text[] AS keywords
      FROM "Product" p WHERE p."deletedAt" IS NULL AND 'product' IN (${types}) AND ${requested(sql`p."id"`)} AND ${bounded(sql`p."createdAt"`)}`,
    recipe: () => sql`
      SELECT 'recipe', r."id"::text, r."shortcode", r."name", NULL, NULL, ARRAY[]::text[], ARRAY[]::text[]
      FROM "Recipe" r WHERE r."deletedAt" IS NULL AND 'recipe' IN (${types}) AND ${requested(sql`r."id"`)} AND ${bounded(sql`r."createdAt"`)}`,
    ingredient: () => sql`
      SELECT 'ingredient', i."id"::text, i."shortcode", i."name", NULL, NULL, i."aliases", ARRAY[]::text[]
      FROM "Ingredient" i WHERE i."deletedAt" IS NULL AND i."recipeId" IS NULL AND 'ingredient' IN (${types}) AND ${requested(sql`i."id"`)} AND ${bounded(sql`i."createdAt"`)}`,
    cookbook: () => sql`
      SELECT 'cookbook', c."id"::text, c."shortcode", c."name", NULLIF(array_to_string(c."author", ', '), ''), NULL, ARRAY[]::text[], c."subjects"
      FROM "Cookbook" c WHERE c."deletedAt" IS NULL AND 'cookbook' IN (${types}) AND ${requested(sql`c."id"`)} AND ${bounded(sql`c."createdAt"`)}`,
    location: () => sql`
      SELECT 'location', l."id"::text, l."shortcode", l."name",
        (SELECT string_agg(path.name, ' › ' ORDER BY path.depth DESC) FROM location_path path WHERE path."rootId" = l.id AND path.depth > 0),
        l."type", l."aliases", ARRAY[l."type"]::text[]
      FROM "Location" l WHERE l."deletedAt" IS NULL AND 'location' IN (${types}) AND ${requested(sql`l."id"`)} AND ${bounded(sql`l."createdAt"`)}`,
    inventory: () => sql`
      SELECT 'inventory', ie."id"::text, ie."shortcode", p."name", l."name", ${categorySummarySql(sql`p."categoryId"`)}->>'name', p."aliases",
        ARRAY[l."name", l."type", ${productBrandNameSql(sql`p."brandId"`)}]::text[] ||
        COALESCE((SELECT array_agg(pei."externalId") FROM "EntityExternalId" pei
                  WHERE pei."entityId" = p."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL),
                 ARRAY[]::text[])
      FROM "InventoryEntry" ie JOIN "Product" p ON p."id" = ie."productId" AND p."deletedAt" IS NULL JOIN "Location" l ON l."id" = ie."locationId" AND l."deletedAt" IS NULL
      WHERE ie."deletedAt" IS NULL AND 'inventory' IN (${types}) AND ${requested(sql`ie."id"`)} AND ${bounded(sql`ie."createdAt"`)}`,
    meal: () => sql`
      SELECT 'meal', m."id"::text, m."shortcode", COALESCE(NULLIF(m."name", ''), m."date"::text), m."date"::text, NULL, ARRAY[]::text[], ARRAY[m."date"::text]::text[]
      FROM "Meal" m WHERE m."deletedAt" IS NULL AND 'meal' IN (${types}) AND ${requested(sql`m."id"`)} AND ${bounded(sql`m."createdAt"`)}`,
    project: () => sql`
      SELECT 'project', p."id"::text, p."shortcode", p."name", concat_ws(' · ', p."kind", p."status"), p."emoji", ARRAY[]::text[], ARRAY[p."kind", p."status"]::text[] || ${effectiveFieldSql("project", "locations", "p")}
      FROM "Project" p WHERE p."deletedAt" IS NULL AND 'project' IN (${types}) AND ${requested(sql`p."id"`)} AND ${bounded(sql`p."createdAt"`)}`,
    task: () => sql`
      SELECT 'task', t."id"::text, t."shortcode", t."name", p."name", ${effectiveFieldSql("task", "trade", "t")}, ARRAY[]::text[], ARRAY[${effectiveFieldSql("task", "trade", "t")}, sp."name"]::text[]
      FROM "Task" t LEFT JOIN "Project" p ON p."id" = ${effectiveFieldSql("task", "projectId", "t")} AND p."deletedAt" IS NULL LEFT JOIN "Product" sp ON sp."id" = ${effectiveFieldSql("task", "subjectProductId", "t")} AND sp."deletedAt" IS NULL
      WHERE t."deletedAt" IS NULL AND 'task' IN (${types}) AND ${requested(sql`t."id"`)} AND ${bounded(sql`t."createdAt"`)}`,
    vendor: () => sql`
      SELECT 'vendor', v."id"::text, v."shortcode", v."name", v."website", NULL, ARRAY[]::text[], ARRAY[v."website"]::text[]
      FROM "Vendor" v WHERE v."deletedAt" IS NULL AND 'vendor' IN (${types}) AND ${requested(sql`v."id"`)} AND ${bounded(sql`v."createdAt"`)}`,
    // An orderless Purchase with an unknown date still has its Vendor as a title.
    purchase: () => sql`
      SELECT 'purchase', pu."id"::text, pu."shortcode", COALESCE(NULLIF(pu."orderId", ''), concat_ws(' · ', v."name", pu."date"::text)), v."name", NULL, ARRAY[]::text[], ARRAY[pu."orderId", pu."displayLabel", pu."notes", v."name", v."website", pu."date"::text]::text[]
      FROM "Purchase" pu JOIN "Vendor" v ON v."id" = pu."vendorId" AND v."deletedAt" IS NULL
      WHERE pu."deletedAt" IS NULL AND 'purchase' IN (${types}) AND ${requested(sql`pu."id"`)} AND ${bounded(sql`pu."createdAt"`)}`,
    financialAccount: () => sql`
      SELECT ${"financialAccount"}::text, fa."id"::text, fa."shortcode", fa."name", fa."identity"->>'kind', fa."identity"->>'kind', ARRAY[]::text[],
        ARRAY(
          SELECT term
          FROM jsonb_array_elements(fa."sourceAliases") alias,
            LATERAL unnest(ARRAY[alias->>'source', alias->>'alias', alias->>'externalAccountId']) term
          WHERE term IS NOT NULL AND term <> ''
        ) || ARRAY(
          SELECT card->>'last4' FROM jsonb_array_elements(fa."cardNumbers") card
        )
      FROM "FinancialAccount" fa WHERE fa."deletedAt" IS NULL AND ${"financialAccount"}::text IN (${types}) AND ${requested(sql`fa."id"`)} AND ${bounded(sql`fa."createdAt"`)}`,
    financialTransaction: () => sql`
      SELECT 'financialTransaction', ft."id"::text, ft."shortcode", COALESCE(NULLIF(ft."merchant", ''), NULLIF(ft."rawDescription", ''), ft."kind"), fa."name", ft."status", ARRAY[]::text[], ARRAY[ft."sourceCategory", ft."transactionDate"::text, ft."postedDate"::text]::text[]
      FROM "FinancialTransaction" ft JOIN "FinancialAccount" fa ON fa."id" = ft."accountId" AND fa."deletedAt" IS NULL
      WHERE ft."deletedAt" IS NULL AND 'financialTransaction' IN (${types}) AND ${requested(sql`ft."id"`)} AND ${bounded(sql`ft."createdAt"`)}`,
    expense: () => sql`
      SELECT 'expense', e."id"::text, e."shortcode", e."name", names."projectNames", CASE WHEN e."lineKind" = 'principal' THEN e."costType" ELSE e."lineKind" END, ARRAY[]::text[], ARRAY[e."lineKind", ${effectiveExpenseTradeSql("e")}, e."costType", e."notes"]::text[]
      FROM "Expense" e
      LEFT JOIN (${expenseDerivedReadSql("names", { expenseIds: expenseNameIds })}) names ON names."expenseId" = e."id"
      WHERE e."deletedAt" IS NULL AND 'expense' IN (${types}) AND ${requested(sql`e."id"`)} AND ${bounded(sql`e."createdAt"`)}`,
    wish: () => sql`
      SELECT 'wish', w."id"::text, w."shortcode", w."name", w."notes", 'tool wishlist', ARRAY[]::text[], ARRAY['tool wishlist']::text[]
      FROM "Wish" w WHERE w."deletedAt" IS NULL AND 'wish' IN (${types}) AND ${requested(sql`w."id"`)} AND ${bounded(sql`w."createdAt"`)}`,
    // The crop label lives in static data, not SQL, so the title is the plant
    // name and the crop key rides along as a search term.
    plant: () => sql`
      SELECT 'plant', p."id"::text, p."shortcode", p."name",
        concat_ws(' · ', p."gardenGuideKey", p."verdict"), p."verdict",
        ARRAY[]::text[], ARRAY[p."gardenGuideKey", p."latinName"]::text[]
      FROM "Plant" p
      WHERE p."deletedAt" IS NULL AND 'plant' IN (${types}) AND ${requested(sql`p."id"`)} AND ${bounded(sql`p."createdAt"`)}`,
    // Title is the plant name (see `plant` above for why not its crop label).
    planting: () => sql`
      SELECT 'planting', pl."id"::text, pl."shortcode",
        COALESCE(p."name", 'Unknown plant'),
        concat_ws(' · ', pl."status", l."name"), pl."status",
        ARRAY[]::text[], ARRAY[p."gardenGuideKey", l."name"]::text[]
      FROM "Planting" pl
      LEFT JOIN "Plant" p ON p."id" = pl."plantId" AND p."deletedAt" IS NULL
      LEFT JOIN "Location" l ON l."id" = pl."locationId" AND l."deletedAt" IS NULL
      WHERE pl."deletedAt" IS NULL AND 'planting' IN (${types}) AND ${requested(sql`pl."id"`)} AND ${bounded(sql`pl."createdAt"`)}`,
    // Title mirrors `gardenEntryDisplayName` (garden/index.ts): kind label ·
    // observed date · location name. Subtitle is the comma-separated set of
    // live linked planting display names.  The correlated aggregate keeps the
    // source projection one row per GardenEntry even when an entry names many
    // plantings.
    gardenEntry: () => sql`
      SELECT 'gardenEntry', ge."id"::text, ge."shortcode",
        (CASE ge."kind" WHEN ${gardenEntryKind.enum.note} THEN 'Note' WHEN ${gardenEntryKind.enum.harvest} THEN 'Harvest' ELSE 'Move' END)
          || ' · ' || to_char(ge."observedOn", 'YYYY-MM-DD') || ' · ' || l."name",
        (SELECT string_agg(COALESCE(p."name", 'Unknown plant'), ', ' ORDER BY pl."shortcode")
         FROM "EntityLink" gep
         JOIN "Planting" pl ON pl."id" = gep."toEntityId" AND pl."deletedAt" IS NULL
         LEFT JOIN "Plant" p ON p."id" = pl."plantId" AND p."deletedAt" IS NULL
         WHERE gep."fromEntityId" = ge."id" AND gep."deletedAt" IS NULL AND gep."kind" = 'gardenEntryPlanting'),
        ge."kind", ARRAY[]::text[], ARRAY[l."name", ge."harvestAmount"]::text[]
      FROM "GardenEntry" ge
      JOIN "Location" l ON l."id" = ge."locationId" AND l."deletedAt" IS NULL
      WHERE ge."deletedAt" IS NULL AND 'gardenEntry' IN (${types}) AND ${requested(sql`ge."id"`)} AND ${bounded(sql`ge."createdAt"`)}`,
    sourceTransactionRecord: () => sql`
      SELECT 'sourceTransactionRecord', r.id::text, r.shortcode,
        COALESCE(NULLIF(r."rawDescription", ''), r.merchant, r."accountDescriptor"), r."accountDescriptor",
        r.source, ARRAY[r."externalId"]::text[], ARRAY[r.merchant, r."sourceCategory", r.notes]::text[]
      FROM "SourceTransactionRecord" r WHERE r."deletedAt" IS NULL AND 'sourceTransactionRecord' IN (${types}) AND ${requested(sql`r.id`)} AND ${bounded(sql`r."createdAt"`)}`,
    shipment: () => sql`
      SELECT 'shipment', s.id::text, s.shortcode, s.name, s."trackingNumber",
        s.purpose, ARRAY[]::text[], ARRAY[s.notes]::text[]
      FROM "Shipment" s WHERE s."deletedAt" IS NULL AND 'shipment' IN (${types}) AND ${requested(sql`s.id`)} AND ${bounded(sql`s."createdAt"`)}`,
    transactionImport: () => sql`
      SELECT 'transactionImport', i.id::text, i.shortcode, i.label, i.fingerprint,
        i.source, ARRAY[]::text[], ARRAY[i.notes]::text[]
      FROM "TransactionImport" i WHERE i."deletedAt" IS NULL AND 'transactionImport' IN (${types}) AND ${requested(sql`i.id`)} AND ${bounded(sql`i."createdAt"`)}`,
  } satisfies Record<SearchableEntity, () => SQL>;

  // An empty typed arm owns the shared columns independently of the first
  // requested kind. Only requested source builders are constructed/planned.
  const header = sql`SELECT NULL::text AS "entityKind", NULL::text AS "entityId",
    NULL::text AS shortcode, NULL::text AS title, NULL::text AS subtitle,
    NULL::text AS "typeHint", ARRAY[]::text[] AS aliases,
    ARRAY[]::text[] AS keywords WHERE false`;
  const union = sql.join(
    [header, ...selectedKinds.map((kind) => branches[kind]())],
    sql` UNION ALL `,
  );

  const cursor = page?.cursor
    ? sql`WHERE (source."entityKind", source."entityId"::uuid) > (${page.cursor.entityKind}, ${page.cursor.entityId}::uuid)`
    : sql``;
  const limit = page?.pageSize ? sql`LIMIT ${page.pageSize}` : sql``;
  const locationPath = selectedKinds.includes("location")
    ? sql`
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
  `
    : sql``;
  return { locationPath, union, cursor, limit };
}

/** One COUNT over the sources a repair pass pages, under the same cutoff. */
export async function countSearchDocumentSources(
  db: Database | DrizzleTransaction,
  entityKinds: SearchableEntity[],
  createdBefore: string,
): Promise<number> {
  const query = searchDocumentSourceSql(entityKinds, undefined, {
    createdBefore,
  });
  if (!query) return 0;
  const result = await unwrapDb(db).execute<{ count: number }>(sql`
    ${query.locationPath}
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
  const query = searchDocumentSourceSql(entityKinds, entityIds, page);
  if (!query) return [];
  const { locationPath, union, cursor, limit } = query;
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
    ${locationPath}
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
    WHERE "deletedAt" IS NULL ${cursor}
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
      WHERE "deletedAt" IS NULL
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
      AND d."deletedAt" IS NULL
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
      AND "deletedAt" IS NULL
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
      AND sd."deletedAt" IS NULL
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
    AND ee."deletedAt" IS NULL
    AND ee."artifactState" = ${embeddingArtifactState.enum.selected} AND ee."artifactHash" IS NOT NULL AND ee."vectorHash" IS NOT NULL
    AND ee."observedAt" IS NOT NULL AND ee."indexedAt" IS NOT NULL
  WHERE sd."deletedAt" IS NULL
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
          SELECT 1 FROM "DerivedDirty" d WHERE d.target IN (${sql.join(
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
