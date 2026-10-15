import type { ProductCategoryId, ProductId } from "@cubby/schemas/identifiers";
import { impliedProductFeature } from "@cubby/schemas/product";
import {
  isPlantingSourceFeature,
  isProjectResourceFeature,
  projectResourceFeatureLabels,
} from "@cubby/schemas/product-category-relations";
import { and, eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {
  entityExternalId,
  entityLink,
  planting,
  product,
} from "~/server/db/schema";
import {
  getCategoryFeature,
  resolveProductCategory,
} from "~/server/domains/product-category/repo/product-category";
import { createAppError } from "~/server/errors/app-error";
import { liveLinks } from "~/server/generic/entity-links/repo/entity-links";

import { externalIdsContainIsbn } from "./update-helpers";

/**
 * Resolve one requested category against Product evidence and live dependent
 * edges. Import and direct-update paths share this rather than letting a raw
 * scalar write bypass food, ISBN, or project-resource admission.
 */
export async function assertProductCategoryChange(
  tx: DrizzleTransaction,
  productId: ProductId,
  requestedCategoryId: ProductCategoryId | null,
): Promise<ProductCategoryId | null> {
  const current = await tx.query.product.findFirst({
    where: and(eq(product.id, productId), notDeleted(product)),
    columns: { fdc_id: true, ingredientId: true },
  });
  if (!current) throw createAppError("PRODUCT_NOT_FOUND", "Product not found");
  const externalIds = await tx.query.entityExternalId.findMany({
    where: and(
      eq(entityExternalId.entityId, productId),
      notDeleted(entityExternalId),
    ),
  });
  const categoryId = await resolveProductCategory(
    tx,
    requestedCategoryId,
    impliedProductFeature({
      fdc_id: current.fdc_id,
      ingredientId: current.ingredientId,
      hasIsbn: externalIdsContainIsbn(externalIds),
    }),
  );
  const feature = await getCategoryFeature(tx, categoryId);
  const projectUsage = await tx.query.entityLink.findFirst({
    where: and(eq(entityLink.toEntityId, productId), liveLinks("projectTool")),
    columns: { id: true },
  });
  if (projectUsage && !isProjectResourceFeature(feature)) {
    throw createAppError(
      "PRODUCT_CATEGORY_INELIGIBLE",
      `A Product used as a project resource must be in a category that allows project resources (${projectResourceFeatureLabels}).`,
    );
  }
  const gardenSource = await tx.query.planting.findFirst({
    where: and(eq(planting.sourceProductId, productId), notDeleted(planting)),
    columns: { id: true },
  });
  if (gardenSource && !isPlantingSourceFeature(feature)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A planting source Product must be a garden product, not a food Product.",
    );
  }
  return categoryId;
}
