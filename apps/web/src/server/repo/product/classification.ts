import type { ProductCategoryId, ProductId } from "@cubby/schemas/identifiers";
import { hasFoodIndicators } from "@cubby/schemas/product";
import {
  isProjectResourceFeature,
  projectResourceFeatureLabels,
} from "@cubby/schemas/product-category-fields";
import { and, eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  product,
  productExternalId,
  projectToolUsage,
  planting,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { notDeleted } from "~/server/repo/database-helpers";
import {
  getCategoryFeature,
  resolveProductCategory,
} from "~/server/repo/product-category";

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
  const externalIds = await tx.query.productExternalId.findMany({
    where: and(
      eq(productExternalId.productId, productId),
      notDeleted(productExternalId),
    ),
  });
  const requiredFeature = hasFoodIndicators({
    fdc_id: current.fdc_id,
    ingredientId: current.ingredientId,
  })
    ? "food"
    : externalIdsContainIsbn(externalIds)
      ? "books"
      : null;
  const categoryId = await resolveProductCategory(
    tx,
    requestedCategoryId,
    requiredFeature,
  );
  const feature = await getCategoryFeature(tx, categoryId);
  const projectUsage = await tx.query.projectToolUsage.findFirst({
    where: and(
      eq(projectToolUsage.productId, productId),
      notDeleted(projectToolUsage),
    ),
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
  if (gardenSource && feature === "food") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A planting source Product must be a garden product, not a food Product.",
    );
  }
  return categoryId;
}
