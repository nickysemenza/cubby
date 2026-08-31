import { type Entity, entityRefKey, entitySchema } from "@cubby/schemas/entity";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import { displayableImageSql } from "~/server/repo/image-displayability";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

/** A private database identity used only while hydrating public read models. */
export interface EntityDisplayImageRef {
  entityType: Entity;
  entityId: string;
}

const DISPLAY_IMAGE_ENTITIES = new Set<Entity>([
  "product",
  "inventory",
  "expense",
  "task",
  "recipe",
  "cookbook",
  "location",
  "project",
  "purchase",
  // Vendor owns a single logo FK rather than an image-association gallery.
  "vendor",
]);

const displayImageRowSchema = z.object({
  entityType: entitySchema,
  entityId: z.string(),
  key: z.string().nullable(),
});

/**
 * Resolve the canonical display image for a mixed batch of private entity refs.
 *
 * This is the backend policy shared by search and enriched entity-link reads.
 * Callers keep UUIDs private, map the returned summaries onto their public DTOs,
 * and use a semantic entity mark when a ref is absent from the result.
 */
export async function resolveEntityDisplayImages(
  db: Database,
  refs: readonly EntityDisplayImageRef[],
): Promise<Map<string, ImageUrlSummary>> {
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
  const result = await getDb(db).execute(sql`
    WITH refs("entityType", "entityId") AS (VALUES ${values})
    SELECT refs."entityType", refs."entityId"::text AS "entityId", (
      SELECT candidates.key
      FROM (
        SELECT i.key, 0 AS priority, pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProductImage" pi
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" IN ('product', 'inventory', 'expense', 'task')
          AND pi."productId" = CASE
            WHEN refs."entityType" = 'product' THEN refs."entityId"
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
            WHEN refs."entityType" = 'task' THEN (
              SELECT t."subjectProductId"
              FROM "Task" t
              JOIN "Product" p ON p.id = t."subjectProductId" AND p."deletedAt" IS NULL
              WHERE t.id = refs."entityId" AND t."deletedAt" IS NULL
            )
          END
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, 0 AS priority, ri."sortOrder", ri."createdAt", i.id AS "imageId"
        FROM "RecipeImage" ri
        JOIN "Image" i ON i.id = ri."imageId"
        WHERE refs."entityType" = 'recipe' AND ri."recipeId" = refs."entityId"
          AND ri."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, 0 AS priority, li."sortOrder", li."createdAt", i.id AS "imageId"
        FROM "LocationImage" li
        JOIN "Image" i ON i.id = li."imageId"
        WHERE refs."entityType" = 'location' AND li."locationId" = refs."entityId"
          AND li."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        -- A location's own photo wins; the Product it represents is fallback.
        SELECT i.key, 1 AS priority, pi."sortOrder", pi."createdAt", i.id AS "imageId"
        FROM "ProductImage" pi
        JOIN "Image" i ON i.id = pi."imageId"
        WHERE refs."entityType" = 'location'
          AND pi."productId" = (
            SELECT l."productId" FROM "Location" l
            WHERE l.id = refs."entityId" AND l."deletedAt" IS NULL
          )
          AND pi."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, 0 AS priority, 0 AS "sortOrder", c."createdAt", i.id AS "imageId"
        FROM "Cookbook" c
        JOIN "Image" i ON i.id = c."coverImageId"
        WHERE refs."entityType" = 'cookbook' AND c.id = refs."entityId"
          AND c."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, 0 AS priority, pri."sortOrder", pri."createdAt", i.id AS "imageId"
        FROM "ProjectImage" pri
        JOIN "Image" i ON i.id = pri."imageId"
        WHERE refs."entityType" = 'project' AND pri."projectId" = refs."entityId"
          AND pri."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, 0 AS priority, pui."sortOrder", pui."createdAt", i.id AS "imageId"
        FROM "PurchaseImage" pui
        JOIN "Image" i ON i.id = pui."imageId"
        WHERE refs."entityType" = 'purchase' AND pui."purchaseId" = refs."entityId"
          AND pui."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
        UNION ALL
        SELECT i.key, 0 AS priority, 0 AS "sortOrder", v."createdAt", i.id AS "imageId"
        FROM "Vendor" v
        JOIN "Image" i ON i.id = v."logoImageId"
        WHERE refs."entityType" = 'vendor' AND v.id = refs."entityId"
          AND v."deletedAt" IS NULL AND i."deletedAt" IS NULL AND ${displayable}
      ) candidates
      ORDER BY candidates.priority, candidates."sortOrder", candidates."createdAt", candidates."imageId"
      LIMIT 1
    ) AS key
    FROM refs
  `);

  return new Map(
    z
      .array(displayImageRowSchema)
      .parse(result.rows)
      .flatMap((row) =>
        row.key
          ? [
              [
                entityRefKey(row.entityType, row.entityId),
                { url: getR2PublicUrl(row.key) },
              ],
            ]
          : [],
      ),
  );
}
