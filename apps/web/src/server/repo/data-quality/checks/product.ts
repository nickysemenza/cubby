import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { sql } from "drizzle-orm";

import { product } from "~/server/db/schema";
import { displayableImageRawSql } from "~/server/repo/image-displayability";
import { categoryFeatureSql } from "~/server/repo/product-category-sql";
import { derivedPriceFilterSql } from "~/server/repo/product/pricing";

import { defineEntityChecks } from "../registry";

type Product = typeof product;

const AMAZON_SOURCE = "amazon";
const MODEL_REQUIRED_CATEGORIES = [
  "tools",
  "electronics",
  "storage",
  "household",
] as const;

const hasExpenses = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "Expense" dq_e
  WHERE dq_e."productId" = ${t.id} AND dq_e."deletedAt" IS NULL
)`;

// includes-installed: a fixture is in-scope for quality checks (price,
// model, image) the same as any other stocked product.
const hasInventory = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "InventoryEntry" dq_inventory
  WHERE dq_inventory."productId" = ${t.id}
    AND dq_inventory."deletedAt" IS NULL
)`;

const hasStock = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "InventoryEntry" dq_stock
  WHERE dq_stock."productId" = ${t.id}
    AND dq_stock."deletedAt" IS NULL
    AND dq_stock."placement" = 'stock'
)`;

/** Everything except the image and price checks is in scope on spend OR stock. */
const inScope = (t: Product) => sql`(${hasExpenses(t)} OR ${hasInventory(t)})`;

// Must agree with `productIdsWithImages` (product/crud.ts), findProductsWithNoImages
// (product/analytics.ts) and the problems detector: ProductImage is soft-deletable
// separately from Image, and a PDF manual is not a photo. Joining ProductImage
// alone reads `true` for a product whose only attachment is a manual.
const hasDisplayableImage = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "EntityAttachment" dq_pimg
  JOIN "Image" dq_img ON dq_img."id" = dq_pimg."imageId" AND dq_img."deletedAt" IS NULL
  WHERE dq_pimg."subjectEntityId" = ${t.id}
    AND dq_pimg."deletedAt" IS NULL AND dq_pimg."purpose" IS DISTINCT FROM 'label'
    AND ${sql.raw(displayableImageRawSql("dq_img"))}
)`;

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
  SELECT 1 FROM "ProductExternalId" dq_asin
  WHERE dq_asin."productId" = ${t.id}
    AND dq_asin."deletedAt" IS NULL
    AND dq_asin."source" = ${AMAZON_SOURCE}
    AND dq_asin."kind" = 'asin'
)`;

// A photo-inventory-created Product is stocked (has inventory) but was never
// claimed by a purchase: no acquiring Expense, and no explicit PurchaseProduct
// link (the enrichment path a purchase import takes when it later matches
// this same Product — see `product-identity.md`).
const hasPurchaseProductLink = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "PurchaseProduct" dq_pp
  WHERE dq_pp."productId" = ${t.id} AND dq_pp."deletedAt" IS NULL
)`;

const hasExternalId = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "ProductExternalId" dq_xid
  WHERE dq_xid."productId" = ${t.id} AND dq_xid."deletedAt" IS NULL
)`;

const hasExternalIdCollision = (t: Product) => sql`EXISTS (
  SELECT 1
  FROM "ProductExternalId" dq_mine
  JOIN "ProductExternalId" dq_other
    ON dq_other."source" = dq_mine."source"
   AND dq_other."kind" = dq_mine."kind"
   AND dq_other."externalId" = dq_mine."externalId"
   AND dq_other."productId" <> dq_mine."productId"
   AND dq_other."deletedAt" IS NULL
  JOIN "Product" dq_other_product
    ON dq_other_product."id" = dq_other."productId"
   AND dq_other_product."deletedAt" IS NULL
  WHERE dq_mine."productId" = ${t.id}
    AND dq_mine."deletedAt" IS NULL
)`;

const modelRequired = (t: Product) =>
  sql`(${sql.join(
    MODEL_REQUIRED_CATEGORIES.map((feature) =>
      categoryFeatureSql(sql`${t.categoryId}`, feature),
    ),
    sql` OR `,
  )})`;

const derivedPrice = (t: Product) => derivedPriceFilterSql(t.id);

export const productChecks = defineEntityChecks({
  entity: "product",
  table: product,
  exceptions: (t) => t.dataExceptions,
  checks: {
    product_manufacturer: {
      expected: inScope,
      missing: (t) =>
        sql`(trim(${t.manufacturer}) = '' OR lower(trim(${t.manufacturer})) = lower(${UNSPECIFIED_MANUFACTURER}))`,
      fingerprint: (t) => [sql`${t.manufacturer}`],
    },
    product_external_id: {
      expected: inScope,
      missing: (t) => sql`NOT ${hasExternalId(t)}`,
      fingerprint: (t) => [hasExternalId(t)],
    },
    product_category: {
      expected: inScope,
      missing: (t) => sql`${t.categoryId} IS NULL`,
      fingerprint: (t) => [sql`${t.categoryId}`],
    },
    product_model: {
      // Only categories whose things carry a maker's model number.
      expected: (t) => sql`${inScope(t)} AND ${modelRequired(t)}`,
      missing: (t) => sql`(${t.model} IS NULL OR trim(${t.model}) = '')`,
      fingerprint: (t) => [sql`${t.categoryId}`, sql`${t.model}`],
    },
    product_price: {
      // A `misc:` bucket is a heterogeneous pile and is *expected* to be
      // unpriced (the per-location summary makes the same split); a stocked
      // product otherwise carries no value into its location's total.
      expected: (t) =>
        sql`${hasStock(t)} AND lower(${t.name}) NOT LIKE 'misc:%'`,
      missing: (t) => sql`(${t.price} IS NULL AND ${derivedPrice(t)} IS NULL)`,
      fingerprint: (t) => [sql`${t.price}`, derivedPrice(t)],
    },
    product_image: {
      // STOCKED ONLY. An image earns its keep for something you can walk up to
      // and fail to recognise on a shelf; for a sold-off or purely historical
      // product it is decoration. Scoping to inventory also keeps this check
      // from lighting up a large share of the catalogue on day one, which is
      // what would have made it noise rather than a worklist.
      expected: hasInventory,
      missing: (t) => sql`NOT ${hasDisplayableImage(t)}`,
      fingerprint: (t) => [hasInventory(t), hasDisplayableImage(t)],
    },
    amazon_asin: {
      expected: (t) => sql`${inScope(t)} AND ${hasAmazonPurchase(t)}`,
      missing: (t) => sql`NOT ${hasAmazonId(t)}`,
      fingerprint: (t) => [hasAmazonPurchase(t), hasAmazonId(t)],
    },
    duplicate_external_id: {
      expected: inScope,
      missing: hasExternalIdCollision,
      fingerprint: (t) => [hasExternalIdCollision(t)],
    },
    product_unpurchased: {
      expected: hasInventory,
      missing: (t) =>
        sql`NOT (${hasExpenses(t)} OR ${hasPurchaseProductLink(t)})`,
      fingerprint: (t) => [hasExpenses(t), hasPurchaseProductLink(t)],
    },
  },
});
