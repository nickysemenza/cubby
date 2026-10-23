import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { cookbook } from "~/server/db/retained-tables";
import { cookbookSourceRecipeCountSql } from "~/server/domains/cookbook/repo/cookbook-source-count";
import { displayableImageRawSql } from "~/server/domains/image/repo/image-displayability";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const COOKBOOK_QUALITY_RULES_VERSION = 1;

type CookbookQualityRecord = Awaited<
  ReturnType<typeof loadCookbookQualityRecords>
>[number];
const observed = qualityCheck.observed<CookbookQualityRecord>;
const cookbookColumn = (column: string) =>
  sql`"Cookbook".${sql.identifier(column)}`;

export const cookbookChecks = defineStoredEntityChecks({
  entity: "cookbook",
  table: cookbook,
  rulesVersion: COOKBOOK_QUALITY_RULES_VERSION,
  load: loadCookbookQualityRecords,
  checks: {
    cookbook_display_image: qualityCheck.hasImage,
    cookbook_import_incomplete: observed(
      (record) => record.sourceRecipeCount <= record.liveRecipeCount,
    ),
    cookbook_cover: observed((record) => record.hasDisplayableCover),
  },
});

async function loadCookbookQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: cookbook.id,
      shortcode: cookbook.shortcode,
      sourceRecipeCount: cookbookSourceRecipeCountSql(cookbook.rawJson),
      liveRecipeCount: sql<number>`(
        SELECT count(*)::int FROM "Recipe" dq_cookbook_recipe
        WHERE dq_cookbook_recipe."cookbookId" = ${cookbookColumn("id")}
          AND dq_cookbook_recipe."deletedAt" IS NULL
      )`,
      hasDisplayableCover: sql<boolean>`EXISTS (
        SELECT 1 FROM "EntityAttachment" dq_cookbook_attachment
        JOIN "Image" dq_cookbook_image
          ON dq_cookbook_image."id" = dq_cookbook_attachment."imageId"
        WHERE dq_cookbook_attachment."entityId" = ${cookbookColumn("id")}
          AND dq_cookbook_attachment."role" = 'cover'
          AND dq_cookbook_attachment."deletedAt" IS NULL
          AND dq_cookbook_image."deletedAt" IS NULL
          AND ${sql.raw(displayableImageRawSql("dq_cookbook_image"))}
      )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "cookbook",
        cookbookColumn("id"),
      )}`,
    })
    .from(cookbook)
    .where(
      and(
        notDeleted(cookbook),
        sql`${cookbook.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
