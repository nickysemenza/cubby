import { type InventoryPlacement } from "@cubby/shared";
import { and, sql } from "drizzle-orm";

import { hasText } from "~/lib/text-whitespace";
import type { Database, DrizzleTransaction } from "~/server/db";
import { expenseAcquisitionSql } from "~/server/db/computed/expense-aggregate-sql";
import { hasTextSql } from "~/server/db/computed/text-whitespace";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { actualExpenseSql } from "~/server/db/helpers/predicates";
import { product } from "~/server/db/schema";
import { productHasDisplayableImageSql } from "~/server/domains/image/repo/image-displayability";
import { orphanedProductCondition } from "~/server/domains/product/repo/orphan-condition";
import { loadProductPricing } from "~/server/domains/product/repo/pricing";
import { serviceCategorySql } from "~/server/domains/product/repo/service-category";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

type Product = typeof product;

const AMAZON_SOURCE = "amazon";

// includes-installed: a fixture is in scope for the image and purchase checks
// the same as any other stocked product.
const hasInventory = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "InventoryEntry" dq_inventory
  WHERE dq_inventory."productId" = ${t.id}
    AND dq_inventory."deletedAt" IS NULL
)`;

const stockPlacement: InventoryPlacement = "stock";

const hasStock = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "InventoryEntry" dq_stock
  WHERE dq_stock."productId" = ${t.id}
    AND dq_stock."deletedAt" IS NULL
    AND dq_stock."placement" = ${stockPlacement}
)`;

// The shared definition (live attachment, live Image, not a `label`, not a PDF
// manual) also drives the image presence filter, the backfill selections and
// the UPC-gap detector.
const hasDisplayableImage = (t: Product) => productHasDisplayableImageSql(t.id);

const hasAmazonPurchase = (t: Product) => sql`EXISTS (
  SELECT 1
  FROM "Expense" dq_ae
  JOIN "Purchase" dq_ap ON dq_ap."id" = dq_ae."purchaseId" AND dq_ap."deletedAt" IS NULL
  JOIN "Vendor" dq_av ON dq_av."id" = dq_ap."vendorId" AND dq_av."deletedAt" IS NULL
  WHERE dq_ae."productId" = ${t.id}
    AND dq_ae."deletedAt" IS NULL
    AND lower(dq_av."name") LIKE 'amazon%'
)`;

const hasAmazonId = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "EntityExternalId" dq_asin
  WHERE dq_asin."entityId" = ${t.id}
    AND dq_asin."deletedAt" IS NULL
    AND dq_asin."source" = ${AMAZON_SOURCE}
    AND dq_asin."kind" = 'asin'
)`;

// Only a line that brought the Product in counts as purchase evidence: an
// eBay sale or a discard is a product-linked Expense too
// (`expenseAcquisitionSql`).
const hasAcquiringExpense = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "Expense" dq_acq
  WHERE dq_acq."productId" = ${t.id} AND dq_acq."deletedAt" IS NULL
    AND ${sql.raw(actualExpenseSql("dq_acq"))}
    AND ${sql.raw(expenseAcquisitionSql("dq_acq"))}
)`;

// Identity links alone do not prove that the household acquired a Product.
// Confirmation requires a live order; it carries no item cost or quantity.
const hasPurchaseProductLink = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "EntityLink" dq_pp
  JOIN "Purchase" dq_purchase ON dq_purchase."id" = dq_pp."fromEntityId" AND dq_purchase."deletedAt" IS NULL
  WHERE dq_pp."toEntityId" = ${t.id} AND dq_pp."deletedAt" IS NULL AND dq_pp."kind" = 'purchaseProduct'
    AND dq_pp."acquisitionConfirmed" = true
)`;

const hasExternalId = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "EntityExternalId" dq_xid
  WHERE dq_xid."entityId" = ${t.id} AND dq_xid."deletedAt" IS NULL
    AND ${hasTextSql(sql`dq_xid."externalId"`)}
)`;

// A soft-deleted category still sits in `categoryId`; it classifies nothing.
const hasLiveCategory = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "ProductCategory" dq_cat
  WHERE dq_cat."id" = ${t.categoryId} AND dq_cat."deletedAt" IS NULL
)`;

/** Bump when the rules or their declared scoring metadata change. */
export const PRODUCT_QUALITY_RULES_VERSION = 2;

type ProductQualityRecord = Awaited<
  ReturnType<typeof loadProductQualityRecords>
>[number];
const observed = qualityCheck.observed<ProductQualityRecord>;
const when = qualityCheck.when<ProductQualityRecord>;
export const productChecks = defineStoredEntityChecks({
  entity: "product",
  table: product,
  rulesVersion: PRODUCT_QUALITY_RULES_VERSION,
  load: loadProductQualityRecords,
  checks: {
    product_orphaned: observed((r) => !r.orphaned),
    product_name: observed((r) => hasText(r.name)),
    product_brand: when(
      (r) => !r.commodity,
      observed((r) => r.brandId !== null),
    ),
    product_external_id: when(
      (r) => !r.commodity && !r.service,
      observed(
        (r) => (r.model !== null && hasText(r.model)) || r.hasExternalId,
      ),
    ),
    product_category: observed((r) => r.hasLiveCategory),
    // Zero is known. Unstocked historical Products are never charged a price gap;
    // heterogeneous misc: buckets deliberately carry no valuation expectation.
    product_price: when(
      (r) =>
        !r.service &&
        (r.hasStock || r.hasPrice) &&
        !r.name.toLowerCase().startsWith("misc:"),
      observed((r) => r.hasPrice),
    ),
    // Installed fixtures count as inventory for image and purchase evidence.
    product_image: when(
      (r) => r.hasInventory,
      observed((r) => r.hasProductImage),
    ),
    product_display_image: observed((r) => r.hasDisplayImage),
    amazon_asin: when(
      (r) => !r.commodity && r.hasAmazonPurchase,
      observed((r) => r.hasAmazonId),
    ),
    product_unpurchased: when(
      (r) =>
        r.hasInventory &&
        !["gift", "previously_owned"].includes(r.acquisitionOrigin),
      observed((r) => r.hasAcquiringExpense || r.hasPurchaseProductLink),
    ),
  },
});

async function loadProductQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // One source page and one batched pricing read. Domain SQL owners preserve
  // attachment liveness, acquisition policy, orphan retention and kit pricing.
  const rows = await unwrapDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      model: product.model,
      brandId: product.brandId,
      commodity: product.commodity,
      acquisitionOrigin: product.acquisitionOrigin,
      price: product.price,
      // Service Products are charges, not catalogued goods: no identifier or valuation.
      service: sql<boolean>`${serviceCategorySql(sql`${product.categoryId}`)}`,
      orphaned: sql<boolean>`${orphanedProductCondition(product)}`,
      hasInventory: sql<boolean>`${hasInventory(product)}`,
      hasStock: sql<boolean>`${hasStock(product)}`,
      hasExternalId: sql<boolean>`${hasExternalId(product)}`,
      hasLiveCategory: sql<boolean>`${hasLiveCategory(product)}`,
      hasProductImage: sql<boolean>`${hasDisplayableImage(product)}`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("product", sql`${product.id}`)}`,
      hasAmazonPurchase: sql<boolean>`${hasAmazonPurchase(product)}`,
      hasAmazonId: sql<boolean>`${hasAmazonId(product)}`,
      hasAcquiringExpense: sql<boolean>`${hasAcquiringExpense(product)}`,
      hasPurchaseProductLink: sql<boolean>`${hasPurchaseProductLink(product)}`,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
  const pricing = await loadProductPricing(db, rows);
  return rows.map((row) => ({
    ...row,
    hasPrice: pricing.get(row.id)?.effectivePrice != null,
  }));
}
