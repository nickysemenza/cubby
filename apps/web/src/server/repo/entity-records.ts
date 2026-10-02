import { scoredEntities } from "@cubby/schemas/data-quality";
import { entityRefKey, type Entity } from "@cubby/schemas/entity";
import {
  shortcodeEntities,
  entityManifest,
} from "@cubby/schemas/entity-manifest";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  entityRecordSchema,
  type EntityRecordsInput,
} from "~/contracts/entity-records.schema";
import type { Database } from "~/server/db";
import { entryFor, scoreSql, statusSql } from "~/server/repo/data-quality/sql";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  entityDisplayImagePresenceSql,
  resolveEntityDisplayImageLists,
} from "~/server/repo/entity-display-image";
import { labelSql } from "~/server/repo/entity-graph";

const scored = (kind: Entity): kind is (typeof scoredEntities)[number] =>
  scoredEntities.some((candidate) => candidate === kind);

const privateRowSchema = entityRecordSchema
  .omit({ displayImages: true })
  .extend({
    dbId: z.string(),
    quality: z.coerce.number().min(0).max(100).nullable(),
  });

/** Compute costly display fields before paging only when query semantics need them. */
export function buildEntityRecordsQuery(input: EntityRecordsInput): SQL {
  const kinds = shortcodeEntities.filter(
    (kind) => !input.kind || kind === input.kind,
  );
  if (kinds.length === 0)
    return sql`SELECT 0 AS "totalCount", '[]'::json AS items`;
  const earlyName = Boolean(input.q) || input.orderBy === "name";
  const earlyQuality =
    input.orderBy === "quality" ||
    input.qualityMin !== undefined ||
    input.qualityMax !== undefined;
  const earlyImage = input.orderBy === "hasImage" || Boolean(input.image);
  const qualityFor = (kind: Entity) =>
    scored(kind) ? scoreSql(kind, entryFor(kind).table) : sql`NULL::numeric`;
  const pageBranches: SQL[] = [];
  const branches = kinds.map((kind) => {
    const table = entityManifest[kind].dbTable;
    if (!table)
      throw new Error(`Shortcode entity ${kind} has no payload table`);
    const payload = sql.identifier(table);
    const id = sql`${payload}."id"`;
    const fields = {
      name: sql`${labelSql(kind, `"${table}"`)} AS name`,
      quality: sql`${qualityFor(kind)} AS quality`,
      image: sql`${entityDisplayImagePresenceSql(kind, id)} AS "hasImage"`,
    };
    const early: SQL[] = [];
    // Status is display-only: evaluate it for the requested page, never the roster.
    const late: SQL[] = [
      sql`, ${scored(kind) ? statusSql(kind, entryFor(kind).table) : sql`NULL::text`} AS "qualityStatus"`,
    ];
    for (const [field, needed] of [
      [fields.name, earlyName],
      [fields.quality, earlyQuality],
      [fields.image, earlyImage],
    ] as const) {
      (needed ? early : late).push(sql`, ${field}`);
    }
    if (late.length)
      pageBranches.push(sql`
        SELECT page.* ${sql.join(late, sql``)}
        FROM page JOIN ${payload} ON ${id} = page."dbId"::uuid
        WHERE page.kind = ${kind}
      `);
    return sql`
      SELECT identity.id::text AS "dbId", identity.shortcode AS id,
        identity.kind, identity."createdAt", ${payload}."updatedAt"
        ${sql.join(early, sql``)}
      FROM "Entity" identity JOIN ${payload} ON ${id} = identity.id
      WHERE identity.kind = ${kind} AND identity."deletedAt" IS NULL
        AND identity."mergedIntoId" IS NULL AND ${payload}."deletedAt" IS NULL
    `;
  });
  const predicates: SQL[] = [];
  if (input.q) {
    // Name/code search is literal; wildcard characters cannot widen the roster.
    const pattern = `%${input.q.replace(/[\\%_]/g, "\\$&")}%`;
    predicates.push(sql`(name ILIKE ${pattern} OR id ILIKE ${pattern})`);
  }
  if (input.image) predicates.push(sql`"hasImage" = ${input.image === "has"}`);
  if (input.qualityMin !== undefined)
    predicates.push(sql`quality >= ${input.qualityMin}`);
  if (input.qualityMax !== undefined)
    predicates.push(sql`quality <= ${input.qualityMax}`);
  for (const [column, from, to] of [
    ["createdAt", input.createdFrom, input.createdTo],
    ["updatedAt", input.updatedFrom, input.updatedTo],
  ] as const) {
    if (from) predicates.push(sql`${sql.identifier(column)} >= ${from}::date`);
    if (to)
      predicates.push(
        sql`${sql.identifier(column)} < ${to}::date + interval '1 day'`,
      );
  }
  const where = predicates.length
    ? sql`WHERE ${sql.join(predicates, sql` AND `)}`
    : sql``;
  const order = sql.identifier(input.orderBy);
  const direction = input.direction === "asc" ? sql`ASC` : sql`DESC`;
  // One snapshot supplies both rows and count, including empty/out-of-range pages.
  return sql`
    WITH roster AS (${sql.join(branches, sql` UNION ALL `)}),
    filtered AS (SELECT * FROM roster ${where}),
    page AS MATERIALIZED (
      SELECT * FROM filtered ORDER BY ${order} ${direction} NULLS LAST, id ASC
      LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}
    ),
    enriched AS (${pageBranches.length ? sql.join(pageBranches, sql` UNION ALL `) : sql`SELECT * FROM page`})
    SELECT (SELECT count(*)::int FROM filtered) AS "totalCount",
      COALESCE((SELECT json_agg(enriched ORDER BY ${order} ${direction} NULLS LAST, id ASC) FROM enriched), '[]'::json) AS items
  `;
}

export async function listEntityRecords(
  db: Database,
  input: EntityRecordsInput,
) {
  const result = await unwrapDb(db).execute(buildEntityRecordsQuery(input));
  const parsed = z
    .object({
      totalCount: z.coerce.number().int().nonnegative(),
      items: z.array(privateRowSchema),
    })
    .parse(result.rows[0]);
  const images = await resolveEntityDisplayImageLists(
    db,
    parsed.items.map((row) => ({
      entityKind: row.kind,
      entityId: row.dbId,
    })),
  );
  return {
    totalCount: parsed.totalCount,
    items: parsed.items.map(({ dbId, ...row }) =>
      entityRecordSchema.parse({
        ...row,
        displayImages: images.get(entityRefKey(row.kind, dbId)) ?? [],
      }),
    ),
  };
}
