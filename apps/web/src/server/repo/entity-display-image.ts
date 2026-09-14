import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { type Entity, entityRefKey, entitySchema } from "@cubby/schemas/entity";
import {
  galleryEntities,
  type GalleryEntity,
} from "@cubby/schemas/entity-manifest";
import { imageShortcode } from "@cubby/schemas/identifiers";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { imageJoinBindings, unwrapDb } from "~/server/repo/database-helpers";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

/** A private database identity used only while hydrating public read models. */
export interface EntityDisplayImageRef {
  entityType: Entity;
  entityId: string;
}

const DISPLAY_IMAGE_ENTITIES = new Set<Entity>([
  "image",
  ...galleryEntities,
  "cookbook",
  // Borrowed covers: no gallery of their own, a linked product's photos.
  "inventory",
  "expense",
  "ingredient",
  "wish",
  // Vendor owns a single logo FK rather than an image-association gallery.
  "vendor",
]);

/**
 * One priority-0 UNION ALL arm per gallery entity, mechanically derived from
 * `imageJoinBindings` rather than hand-listed — the same seam
 * `repo/image.ts`'s edge operations read, so a new gallery entity's own
 * photos are covered here the moment it is declared in the manifest. Every
 * `<Entity>Image` join table shares this exact shape: `imageId` FK, a single
 * parent-id column, `sortOrder`/`createdAt`/`deletedAt`.
 */
const ownGalleryUnionBranch = (
  entity: GalleryEntity,
  displayable: SQL,
): SQL => {
  const binding = imageJoinBindings[entity];
  const joinTable = binding.table;
  return sql`
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", ${joinTable.sortOrder} AS "sortOrder", ${joinTable.createdAt} AS "createdAt", i.id AS "imageId"
        FROM ${joinTable}
        JOIN "Image" i ON i.id = ${joinTable.imageId}
        WHERE refs."entityType" = ${entity} AND ${binding.parentIdColumn} = refs."entityId"
          AND ${joinTable.deletedAt} IS NULL AND i."deletedAt" IS NULL AND ${displayable}`;
};

const displayImageRowSchema = z.object({
  entityType: entitySchema,
  entityId: z.string(),
  images: z.array(z.object({ id: imageShortcode, key: z.string() })),
});

/**
 * Resolve every displayable image, in display order, for a mixed batch of
 * private entity refs.
 *
 * This is THE display-image policy: list rows' `displayImages`, search hits,
 * entity-link hover cards and the audit log all read it, and no client derives
 * a cover itself. An entity's own gallery/cover comes first (priority 0),
 * mechanically for every `GalleryEntity` — see {@link ownGalleryUnionBranch}.
 * A `"borrowed"` entity (ingredient, inventory, expense, wish) has no gallery
 * of its own and shows only its linked product's photos. Four entities have
 * BOTH: a location or cookbook falls back to the product it represents; a
 * task falls back to its subject product; a planting falls back to its
 * garden entries' photos, newest entry first — each as its own priority-1
 * UNION arm. Callers keep UUIDs private, map the returned summaries onto
 * their public DTOs, and use a semantic entity mark when a ref resolves to
 * nothing.
 */
async function resolveEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  const supported = [
    ...new Map(
      refs
        .filter((ref) => DISPLAY_IMAGE_ENTITIES.has(ref.entityType))
        .map((ref) => [entityRefKey(ref.entityType, ref.entityId), ref]),
    ).values(),
  ];
  if (supported.length === 0) return new Map();

  const values = sql.join(
    supported.map(
      (ref) => sql`(${ref.entityType}::text, ${ref.entityId}::uuid)`,
    ),
    sql`, `,
  );
  const displayable = displayableImageSql("i");
  const ownGalleryBranches = sql.join(
    galleryEntities.map((entity) => ownGalleryUnionBranch(entity, displayable)),
    sql`
        UNION ALL`,
  );
  const result = await unwrapDb(db).execute(sql`
    WITH refs("entityType", "entityId") AS (VALUES ${values})
    SELECT refs."entityType", refs."entityId"::text AS "entityId", (
      SELECT COALESCE(
        json_agg(
          json_build_object('id', candidates.shortcode, 'key', candidates.key)
          ORDER BY candidates.priority, candidates."groupCreatedAt", candidates."groupId",
                   candidates."sortOrder", candidates."createdAt", candidates."imageId"
        ),
        '[]'::json
      )
      FROM (
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", i."createdAt", i.id AS "imageId"
        FROM "Image" i
        WHERE refs."entityType" = 'image' AND i.id = refs."entityId"
          AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Borrowed (unrelated to any gallery join table): inventory/expense
        -- each resolve to the product they're about, then show its photos.
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProductImage" pi
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" IN ('inventory', 'expense')
          AND pi."productId" = CASE
            WHEN refs."entityType" = 'inventory' THEN (
              SELECT ie."productId"
              FROM "InventoryEntry" ie
              JOIN "Product" p ON p.id = ie."productId" AND p."deletedAt" IS NULL
              WHERE ie.id = refs."entityId" AND ie."deletedAt" IS NULL
            )
            WHEN refs."entityType" = 'expense' THEN (
              SELECT e."productId"
              FROM "Expense" e
              JOIN "Product" p ON p.id = e."productId" AND p."deletedAt" IS NULL
              WHERE e.id = refs."entityId" AND e."deletedAt" IS NULL
            )
          END
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        ${ownGalleryBranches}
        UNION ALL
        -- A location's own photo wins; the Product it represents is fallback.
        SELECT i.key, i.shortcode, 1 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProductImage" pi
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'location'
          AND pi."productId" = (
            SELECT l."productId" FROM "Location" l
            WHERE l.id = refs."entityId" AND l."deletedAt" IS NULL
          )
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", c."createdAt", i.id AS "imageId"
        FROM "Cookbook" c
        JOIN "Image" i ON i.id = c."coverImageId"
        WHERE refs."entityType" = 'cookbook' AND c.id = refs."entityId"
          AND c."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- A cookbook's own cover wins; the physical copy on the shelf (its
        -- linked Product) is fallback.
        SELECT i.key, i.shortcode, 1 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProductImage" pi
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'cookbook'
          AND pi."productId" = (
            SELECT c."productId" FROM "Cookbook" c
            WHERE c.id = refs."entityId" AND c."deletedAt" IS NULL
          )
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- A task's own photos win; its subject product's are fallback.
        SELECT i.key, i.shortcode, 1 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProductImage" pi
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'task'
          AND pi."productId" = (
            SELECT t."subjectProductId"
            FROM "Task" t
            JOIN "Product" p ON p.id = t."subjectProductId" AND p."deletedAt" IS NULL
            WHERE t.id = refs."entityId" AND t."deletedAt" IS NULL
          )
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- A planting's own photos win; its garden entries' are fallback, newest
        -- entry first — the negated epoch makes ascending sort read as "newest".
        SELECT i.key, i.shortcode, 1 AS priority, to_timestamp(-EXTRACT(EPOCH FROM ge."observedOn"::timestamptz)) AS "groupCreatedAt", ge.id AS "groupId", gi."sortOrder", gi."createdAt", i.id AS "imageId"
        FROM "GardenEntry" ge
        JOIN "GardenEntryImage" gi ON gi."gardenEntryId" = ge.id
        JOIN "Image" i ON i.id = gi."imageId"
        WHERE refs."entityType" = 'planting' AND ge."plantingId" = refs."entityId"
          AND ge."deletedAt" IS NULL AND gi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Borrowed: every linked product's photos, products in link order
        -- (the same linkOrder the ingredient list Product pill uses).
        SELECT i.key, i.shortcode, 0 AS priority, p."createdAt" AS "groupCreatedAt", p.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "Product" p
        JOIN "ProductImage" pi ON pi."productId" = p.id
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'ingredient' AND p."ingredientId" = refs."entityId"
          AND p."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Borrowed: candidate products' photos, candidates in link order.
        SELECT i.key, i.shortcode, 0 AS priority, wc."createdAt" AS "groupCreatedAt", wc.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "WishCandidate" wc
        JOIN "Product" p ON p.id = wc."productId" AND p."deletedAt" IS NULL
        JOIN "ProductImage" pi ON pi."productId" = p.id
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'wish' AND wc."wishId" = refs."entityId"
          AND wc."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", v."createdAt", i.id AS "imageId"
        FROM "Vendor" v
        JOIN "Image" i ON i.id = v."logoImageId"
        WHERE refs."entityType" = 'vendor' AND v.id = refs."entityId"
          AND v."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
      ) candidates
    ) AS images
    FROM refs
  `);

  return new Map(
    z
      .array(displayImageRowSchema)
      .parse(result.rows)
      .map((row) => [
        entityRefKey(row.entityType, row.entityId),
        row.images.map((img) => ({ id: img.id, url: getR2PublicUrl(img.key) })),
      ]),
  );
}

/**
 * The cover only — `[0]` of {@link resolveEntityDisplayImageLists} — for
 * callers that render a single mark (search hits, hover cards, audit rows).
 * Refs that resolve to no image are absent from the map.
 */
export async function resolveEntityDisplayImages(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, ImageUrlSummary>> {
  const lists = await resolveEntityDisplayImageLists(db, refs);
  return new Map(
    [...lists].flatMap(([key, images]) =>
      images[0] ? [[key, { url: images[0].url }]] : [],
    ),
  );
}

/**
 * Attach `displayImages` to a page of list rows: one resolver call for the
 * page, rows keyed by private id, mapped to their public shape by `toOut`.
 * Every `displayImages` manifest entity's list function goes through this,
 * so the list contract (web thumbnails, native rows) has exactly one source.
 */
export async function withDisplayImages<Row extends { id: string }, Out>(
  db: Database | DrizzleTransaction,
  entityType: Entity,
  rows: readonly Row[],
  // Mappers that parse their row against the list schema take the images as
  // an argument so the parse sees them; the spread below covers the rest.
  toOut: (row: Row, displayImages: DisplayImageSummary[]) => Out,
): Promise<Array<Out & { displayImages: DisplayImageSummary[] }>> {
  const lists = await resolveEntityDisplayImageLists(
    db,
    rows.map((row) => ({ entityType, entityId: row.id })),
  );
  return rows.map((row) => {
    const displayImages = lists.get(entityRefKey(entityType, row.id)) ?? [];
    return { ...toOut(row, displayImages), displayImages };
  });
}
