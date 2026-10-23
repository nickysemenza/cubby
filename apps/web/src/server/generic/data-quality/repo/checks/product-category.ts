import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { productCategory } from "~/server/db/retained-tables";
import { categoryMappingSql } from "~/server/domains/product-category/repo/category-connections";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const PRODUCT_CATEGORY_QUALITY_RULES_VERSION = 1;

type ProductCategoryQualityRecord = Awaited<
  ReturnType<typeof loadProductCategoryQualityRecords>
>[number];
const observed = qualityCheck.observed<ProductCategoryQualityRecord>;
const when = qualityCheck.when<ProductCategoryQualityRecord>;
const productCategoryId = sql`"ProductCategory"."id"`;

// Match PostgreSQL trim(), which removes ASCII spaces only.
const hasText = (value: string | null) =>
  value !== null && value.replace(/^ +| +$/g, "") !== "";

export const productCategoryChecks = defineStoredEntityChecks({
  entity: "productCategory",
  table: productCategory,
  rulesVersion: PRODUCT_CATEGORY_QUALITY_RULES_VERSION,
  load: loadProductCategoryQualityRecords,
  checks: {
    productcategory_display_image: qualityCheck.hasImage,
    category_description: observed((record) => hasText(record.description)),
    category_feature: when(
      (record) => record.parentId === null,
      observed((record) => record.feature !== null),
    ),
    category_spending_category: observed(
      (record) => record.spendingMappingState !== "unmapped",
    ),
  },
});

async function loadProductCategoryQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select({
      id: productCategory.id,
      shortcode: productCategory.shortcode,
      description: productCategory.description,
      parentId: productCategory.parentId,
      feature: productCategory.feature,
      spendingMappingState: sql<string>`(${categoryMappingSql(
        productCategoryId,
      )} ->> 'state')`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql(
        "productCategory",
        productCategoryId,
      )}`,
    })
    .from(productCategory)
    .where(
      and(
        notDeleted(productCategory),
        sql`${productCategory.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
