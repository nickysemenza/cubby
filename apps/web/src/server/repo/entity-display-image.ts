import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { type Entity, entityRefKey, entitySchema } from "@cubby/schemas/entity";
import {
  entityManifest,
  galleryEntities,
  isGalleryEntity,
  type CoverEntity,
  type GalleryEntity,
  type LogoEntity,
} from "@cubby/schemas/entity-manifest";
import type { EntityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { imageShortcode, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { cookbook, image, vendor } from "~/server/db/schema";
import {
  imageJoinBindings,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { mapImages } from "~/server/repo/database-helpers/transform";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

/** A private database identity used only while hydrating public read models. */
export interface EntityDisplayImageRef {
  entityType: Entity;
  entityId: string;
}

const DISPLAY_IMAGE_ENTITIES = new Set<Entity>(entitySchema.options);

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
 * Direct storage always wins. Explicit relationship arms then supply truthful
 * fallback imagery without recursively resolving another entity's
 * `displayImages`; that keeps reciprocal relationships such as recipe and meal
 * finite. Callers keep UUIDs private, map the returned summaries onto public
 * DTOs, and use a semantic entity mark when a ref resolves to nothing.
 */
async function resolveUniversalEntityDisplayImageLists(
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
        SELECT DISTINCT ON (raw_candidates."imageId") raw_candidates.*
        FROM (
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", i."createdAt", i.id AS "imageId"
        FROM "Image" i
        WHERE refs."entityType" = 'image' AND i.id = refs."entityId"
          AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Relationship-only (unrelated to any gallery join table): inventory/expense
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
        -- A task without subject-product media may use its project's own photo.
        SELECT i.key, i.shortcode, 2 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", pji."sortOrder", pji."createdAt", i.id AS "imageId"
        FROM "Task" t
        JOIN "ProjectImage" pji ON pji."projectId" = t."projectId"
        JOIN "Image" i ON i.id = pji."imageId"
        WHERE refs."entityType" = 'task' AND t.id = refs."entityId"
          AND t."deletedAt" IS NULL AND pji."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Recipes borrow only directly attached meal photos, newest meal first.
        SELECT i.key, i.shortcode, 1 AS priority, to_timestamp(-EXTRACT(EPOCH FROM m.date::timestamptz)) AS "groupCreatedAt", m.id AS "groupId", mi."sortOrder", mi."createdAt", i.id AS "imageId"
        FROM "MealRecipe" mr
        JOIN "Meal" m ON m.id = mr."mealId" AND m."deletedAt" IS NULL
        JOIN "MealImage" mi ON mi."mealId" = m.id AND mi."deletedAt" IS NULL
        JOIN "Image" i ON i.id = mi."imageId"
        WHERE refs."entityType" = 'recipe' AND mr."recipeId" = refs."entityId"
          AND mr."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Meals borrow directly attached recipe photos in meal-recipe order.
        SELECT i.key, i.shortcode, 1 AS priority, mr."createdAt" AS "groupCreatedAt", mr.id AS "groupId", ri."sortOrder", ri."createdAt", i.id AS "imageId"
        FROM "MealRecipe" mr
        JOIN "Recipe" r ON r.id = mr."recipeId" AND r."deletedAt" IS NULL
        JOIN "RecipeImage" ri ON ri."recipeId" = r.id AND ri."deletedAt" IS NULL
        JOIN "Image" i ON i.id = ri."imageId"
        WHERE refs."entityType" = 'meal' AND mr."mealId" = refs."entityId"
          AND mr."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
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
        -- Seed/source product is the final planting fallback.
        SELECT i.key, i.shortcode, 2 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "Planting" pl
        JOIN "ProductImage" pi ON pi."productId" = pl."sourceProductId" AND pi."deletedAt" IS NULL
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'planting' AND pl.id = refs."entityId"
          AND pl."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
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
        -- Projects prefer direct task evidence, then products explicitly tied
        -- through tasks, expenses, or durable tool usage.
        SELECT i.key, i.shortcode, 1 AS priority, to_timestamp(-EXTRACT(EPOCH FROM t."updatedAt")) AS "groupCreatedAt", t.id AS "groupId", ti."sortOrder", ti."createdAt", i.id AS "imageId"
        FROM "Task" t JOIN "TaskImage" ti ON ti."taskId" = t.id JOIN "Image" i ON i.id = ti."imageId"
        WHERE refs."entityType" = 'project' AND t."projectId" = refs."entityId"
          AND t."deletedAt" IS NULL AND ti."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 2 AS priority, t."createdAt" AS "groupCreatedAt", t.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "Task" t JOIN "ProductImage" pi ON pi."productId" = t."subjectProductId" JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'project' AND t."projectId" = refs."entityId"
          AND t."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 3 AS priority, e."createdAt" AS "groupCreatedAt", e.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "Expense" e JOIN "ProductImage" pi ON pi."productId" = e."productId" JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'project' AND e."projectId" = refs."entityId"
          AND e."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 4 AS priority, ptu."createdAt" AS "groupCreatedAt", ptu.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProjectToolUsage" ptu JOIN "ProductImage" pi ON pi."productId" = ptu."productId" JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'project' AND ptu."projectId" = refs."entityId"
          AND ptu."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Purchases resolve owned receipt photos, then bought products, then vendor.
        SELECT i.key, i.shortcode, 1 AS priority, pp."createdAt" AS "groupCreatedAt", pp.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "PurchaseProduct" pp JOIN "ProductImage" pi ON pi."productId" = pp."productId" JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'purchase' AND pp."purchaseId" = refs."entityId"
          AND pp."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 1 AS priority, e."createdAt" AS "groupCreatedAt", e.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "Expense" e JOIN "ProductImage" pi ON pi."productId" = e."productId" JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'purchase' AND e."purchaseId" = refs."entityId"
          AND e."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 2 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", v."createdAt", i.id AS "imageId"
        FROM "Purchase" pu JOIN "Vendor" v ON v.id = pu."vendorId" JOIN "Image" i ON i.id = v."logoImageId"
        WHERE refs."entityType" = 'purchase' AND pu.id = refs."entityId"
          AND pu."deletedAt" IS NULL AND v."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- Transactions use confirmed allocations only, never advisory vendorInference.
        SELECT i.key, i.shortcode, 1 AS priority, a."createdAt" AS "groupCreatedAt", a.id AS "groupId", pui."sortOrder", pui."createdAt", i.id AS "imageId"
        FROM "FinancialTransactionAllocation" a JOIN "PurchaseImage" pui ON pui."purchaseId" = a."purchaseId" JOIN "Image" i ON i.id = pui."imageId"
        WHERE refs."entityType" = 'financialTransaction' AND a."transactionId" = refs."entityId"
          AND a."deletedAt" IS NULL AND pui."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 2 AS priority, a."createdAt" AS "groupCreatedAt", a.id AS "groupId", pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "FinancialTransactionAllocation" a JOIN "PurchaseProduct" pp ON pp."purchaseId" = a."purchaseId" JOIN "ProductImage" pi ON pi."productId" = pp."productId" JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'financialTransaction' AND a."transactionId" = refs."entityId"
          AND a."deletedAt" IS NULL AND pp."deletedAt" IS NULL AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 3 AS priority, a."createdAt" AS "groupCreatedAt", a.id AS "groupId", 0 AS "sortOrder", v."createdAt", i.id AS "imageId"
        FROM "FinancialTransactionAllocation" a JOIN "Purchase" pu ON pu.id = a."purchaseId" JOIN "Vendor" v ON v.id = pu."vendorId" JOIN "Image" i ON i.id = v."logoImageId"
        WHERE refs."entityType" = 'financialTransaction' AND a."transactionId" = refs."entityId"
          AND a."deletedAt" IS NULL AND pu."deletedAt" IS NULL AND v."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- An expense without product media uses its confirmed purchase vendor.
        SELECT i.key, i.shortcode, 1 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", v."createdAt", i.id AS "imageId"
        FROM "Expense" e
        JOIN "Purchase" pu ON pu.id = e."purchaseId" AND pu."deletedAt" IS NULL
        JOIN "Vendor" v ON v.id = pu."vendorId" AND v."deletedAt" IS NULL
        JOIN "Image" i ON i.id = v."logoImageId"
        WHERE refs."entityType" = 'expense' AND e.id = refs."entityId"
          AND e."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, i.shortcode, 0 AS priority, NULL::timestamptz AS "groupCreatedAt", NULL::uuid AS "groupId", 0 AS "sortOrder", v."createdAt", i.id AS "imageId"
        FROM "Vendor" v
        JOIN "Image" i ON i.id = v."logoImageId"
        WHERE refs."entityType" = 'vendor' AND v.id = refs."entityId"
          AND v."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        ) raw_candidates
        ORDER BY raw_candidates."imageId", raw_candidates.priority,
                 raw_candidates."groupCreatedAt", raw_candidates."groupId",
                 raw_candidates."sortOrder", raw_candidates."createdAt"
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

/** Product rows have no fallback policy: their own gallery is authoritative. */
async function resolveProductDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  if (refs.length === 0) return new Map();
  const values = sql.join(
    refs.map((ref) => sql`(${ref.entityId}::uuid)`),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityId: string;
    images: Array<{ id: string; key: string }>;
  }>(sql`
    WITH refs("entityId") AS (VALUES ${values})
    SELECT refs."entityId"::text AS "entityId",
      COALESCE(
        json_agg(
          json_build_object('id', i.shortcode, 'key', i.key)
          ORDER BY pi."sortOrder", pi."createdAt", i.id
        ) FILTER (WHERE i.id IS NOT NULL),
        '[]'::json
      ) AS images
    FROM refs
    LEFT JOIN "ProductImage" pi
      ON pi."productId" = refs."entityId"
     AND pi."deletedAt" IS NULL
    LEFT JOIN "Image" i
      ON i.id = pi."imageId"
     AND i."deletedAt" IS NULL
     AND ${displayableImageSql("i")}
    GROUP BY refs."entityId"
  `);
  return new Map(
    result.rows.map((row) => [
      entityRefKey("product", row.entityId),
      row.images.map((img) => ({
        id: parseShortcodeFor("image", img.id),
        url: getR2PublicUrl(img.key),
      })),
    ]),
  );
}

/** Location rows need only their own gallery and represented-product fallback. */
async function resolveLocationDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  if (refs.length === 0) return new Map();
  const values = sql.join(
    refs.map((ref) => sql`(${ref.entityId}::uuid)`),
    sql`, `,
  );
  const result = await unwrapDb(db).execute<{
    entityId: string;
    images: Array<{ id: string; key: string }>;
  }>(sql`
    WITH refs("entityId") AS (VALUES ${values}), candidates AS (
      SELECT refs."entityId", i.shortcode, i.key, 0 AS priority,
             li."sortOrder", li."createdAt", i.id AS "imageId"
      FROM refs
      INNER JOIN "LocationImage" li
        ON li."locationId" = refs."entityId"
       AND li."deletedAt" IS NULL
      INNER JOIN "Image" i
        ON i.id = li."imageId"
       AND i."deletedAt" IS NULL
       AND ${displayableImageSql("i")}
      UNION ALL
      SELECT refs."entityId", i.shortcode, i.key, 1 AS priority,
             pi."sortOrder", pi."createdAt", i.id AS "imageId"
      FROM refs
      INNER JOIN "Location" l
        ON l.id = refs."entityId"
       AND l."deletedAt" IS NULL
       AND l."productId" IS NOT NULL
      INNER JOIN "ProductImage" pi
        ON pi."productId" = l."productId"
       AND pi."deletedAt" IS NULL
      INNER JOIN "Image" i
        ON i.id = pi."imageId"
       AND i."deletedAt" IS NULL
       AND ${displayableImageSql("i")}
    )
    SELECT refs."entityId"::text AS "entityId",
      COALESCE(
        (
          SELECT json_agg(
            json_build_object('id', selected.shortcode, 'key', selected.key)
            ORDER BY selected.priority, selected."sortOrder",
                     selected."createdAt", selected."imageId"
          )
          FROM (
            SELECT DISTINCT ON (candidates."imageId") candidates.*
            FROM candidates
            WHERE candidates."entityId" = refs."entityId"
            ORDER BY candidates."imageId", candidates.priority,
                     candidates."sortOrder", candidates."createdAt"
          ) selected
        ),
        '[]'::json
      ) AS images
    FROM refs
  `);
  return new Map(
    result.rows.map((row) => [
      entityRefKey("location", row.entityId),
      row.images.map((img) => ({
        id: parseShortcodeFor("image", img.id),
        url: getR2PublicUrl(img.key),
      })),
    ]),
  );
}

/**
 * Dispatch homogeneous Product batches to the narrow gallery query. Mixed
 * entity batches retain the universal fallback policy for their non-product
 * refs, while avoiding the all-entity UNION for the product portion.
 */
async function resolveEntityDisplayImageLists(
  db: Database | DrizzleTransaction,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, DisplayImageSummary[]>> {
  const supported = refs.filter((ref) =>
    DISPLAY_IMAGE_ENTITIES.has(ref.entityType),
  );
  const entityTypes = new Set(supported.map((ref) => ref.entityType));
  // Graph reads commonly hydrate a product alongside its relationship rows.
  // Keep those mixed batches on one query so image hydration does not add a
  // query per entity family; the narrow paths are for homogeneous reads where
  // they can remove the expensive cross-entity UNION safely.
  if (entityTypes.size > 1) {
    return resolveUniversalEntityDisplayImageLists(db, supported);
  }
  const productRefs = supported.filter((ref) => ref.entityType === "product");
  const locationRefs = supported.filter((ref) => ref.entityType === "location");
  const otherRefs = supported.filter(
    (ref) => ref.entityType !== "product" && ref.entityType !== "location",
  );
  const [productLists, locationLists, otherLists] = await Promise.all([
    resolveProductDisplayImageLists(db, productRefs),
    resolveLocationDisplayImageLists(db, locationRefs),
    resolveUniversalEntityDisplayImageLists(db, otherRefs),
  ]);
  return new Map([...productLists, ...locationLists, ...otherLists]);
}

const publicEntityRowSchema = z.looseObject({ id: z.string() });
type PublicEntityRow = z.output<typeof publicEntityRowSchema>;

type SingleImageEntity = CoverEntity | LogoEntity;
type SingleImageBinding = {
  table: typeof cookbook | typeof vendor;
  imageIdColumn: typeof cookbook.coverImageId | typeof vendor.logoImageId;
  role: "cover" | "logo";
};

/** Exhaustive registry for direct images stored on the owning row. */
const singleImageBindings = {
  cookbook: {
    table: cookbook,
    imageIdColumn: cookbook.coverImageId,
    role: "cover",
  },
  vendor: {
    table: vendor,
    imageIdColumn: vendor.logoImageId,
    role: "logo",
  },
} as const satisfies Record<SingleImageEntity, SingleImageBinding>;

const isSingleImageEntity = (entity: Entity): entity is SingleImageEntity => {
  const storage = entityManifest[entity].imageStorage;
  return storage === "cover" || storage === "logo";
};

const galleryAttachments = async (
  db: Database | DrizzleTransaction,
  entityType: GalleryEntity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  if (entityIds.length === 0) return new Map();
  const binding = imageJoinBindings[entityType];
  const joinTable = binding.table;
  const rows = await unwrapDb(db)
    .select({
      entityId: binding.parentIdColumn,
      ...getTableColumns(image),
    })
    .from(joinTable)
    .innerJoin(image, eq(image.id, joinTable.imageId))
    .where(
      and(
        inArray(binding.parentIdColumn, [...entityIds]),
        notDeleted(joinTable),
        notDeleted(image),
      ),
    )
    .orderBy(
      asc(binding.parentIdColumn),
      asc(joinTable.sortOrder),
      asc(joinTable.createdAt),
      asc(image.id),
    );
  const attachments = new Map<string, EntityAttachmentRead[]>();
  mapImages(rows).forEach((item, index) => {
    const row = rows[index];
    if (!row) return;
    const entityId = String(row.entityId);
    const list = attachments.get(entityId) ?? [];
    list.push({ ...item, role: "attachment", position: list.length });
    attachments.set(entityId, list);
  });
  return attachments;
};

const singleImageAttachments = async (
  db: Database | DrizzleTransaction,
  entityType: SingleImageEntity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  if (entityIds.length === 0) return new Map();
  const binding: SingleImageBinding = singleImageBindings[entityType];
  const rows = await unwrapDb(db)
    .select({ entityId: binding.table.id, ...getTableColumns(image) })
    .from(binding.table)
    .innerJoin(image, eq(image.id, binding.imageIdColumn))
    .where(
      and(
        sql`${binding.table.id} IN (${sql.join(
          entityIds.map((entityId) => sql`${entityId}::uuid`),
          sql`, `,
        )})`,
        notDeleted(binding.table),
        notDeleted(image),
      ),
    );
  const attachments = new Map<string, EntityAttachmentRead[]>();
  mapImages(rows).forEach((item, index) => {
    const row = rows[index];
    if (!row) return;
    attachments.set(String(row.entityId), [
      { ...item, role: binding.role, position: 0 },
    ]);
  });
  return attachments;
};

/** Resolve directly owned files from the storage declared by the manifest. */
export const resolveEntityAttachments = async (
  db: Database | DrizzleTransaction,
  entityType: Entity,
  entityIds: readonly string[],
): Promise<Map<string, EntityAttachmentRead[]>> => {
  const storage = entityManifest[entityType].imageStorage;
  if (storage === false) return new Map();
  if (isGalleryEntity(entityType))
    return galleryAttachments(db, entityType, entityIds);
  if (isSingleImageEntity(entityType))
    return singleImageAttachments(db, entityType, entityIds);
  throw new Error(
    `No direct-attachment binding for ${entityType} (${storage})`,
  );
};

/** Universal public read projection. One shortcode lookup and one image query per batch. */
export async function withUniversalEntityMedia<
  E extends Exclude<Entity, "usda-food">,
>(
  db: Database | DrizzleTransaction,
  entityType: E,
  rows: readonly unknown[],
  detail: boolean,
): Promise<
  Array<
    PublicEntityRow & {
      displayImages: DisplayImageSummary[];
      attachments?: EntityAttachmentRead[];
    }
  >
> {
  const publicRows = rows.map((row) => publicEntityRowSchema.parse(row));
  const resolved = await resolveLiveShortcodes(
    db,
    publicRows.map((row) => row.id),
    entityType,
  );
  const refs = publicRows.flatMap((row) => {
    const entityId = resolved.get(row.id);
    return entityId === undefined ? [] : [{ entityType, entityId }];
  });
  const [lists, attachments] = await Promise.all([
    resolveEntityDisplayImageLists(db, refs),
    detail
      ? resolveEntityAttachments(
          db,
          entityType,
          refs.map((ref) => ref.entityId),
        )
      : Promise.resolve(new Map<string, EntityAttachmentRead[]>()),
  ]);
  return publicRows.map((row) => {
    const entityId = resolved.get(row.id);
    const displayImages = entityId
      ? (lists.get(entityRefKey(entityType, entityId)) ?? [])
      : [];
    return detail
      ? {
          ...row,
          displayImages,
          attachments: entityId ? (attachments.get(entityId) ?? []) : [],
        }
      : { ...row, displayImages };
  });
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
