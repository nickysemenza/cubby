import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { sql } from "drizzle-orm";

import { expenseAcquisitionSql } from "~/server/db/computed/expense-aggregate-sql";
import { product } from "~/server/db/schema";
import { productHasDisplayableImageSql } from "~/server/domains/image/repo/image-displayability";
import { orphanedProductCondition } from "~/server/domains/product/repo/orphan-condition";
import {
  derivedPriceFilterSql,
  hasDerivedProductPriceSql,
  productPriceEvidenceSql,
} from "~/server/domains/product/repo/pricing";

import { defineEntityChecks, type QualityReadContext } from "../registry";

type Product = typeof product;

const AMAZON_SOURCE = "amazon";

// includes-installed: a fixture is in scope for the image and purchase checks
// the same as any other stocked product.
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
    AND ${sql.raw(expenseAcquisitionSql("dq_acq"))}
)`;

// A photo-inventory-created Product is stocked (has inventory) but was never
// claimed by a purchase: no acquiring Expense, and no explicit `purchaseProduct`
// link (the enrichment path a purchase import takes when it later matches
// this same Product — see `product-identity.md`).
const hasPurchaseProductLink = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "EntityLink" dq_pp
  WHERE dq_pp."toEntityId" = ${t.id} AND dq_pp."deletedAt" IS NULL AND dq_pp."kind" = 'purchaseProduct'
)`;

const hasExternalId = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "EntityExternalId" dq_xid
  WHERE dq_xid."entityId" = ${t.id} AND dq_xid."deletedAt" IS NULL
    AND trim(dq_xid."externalId") <> ''
)`;

// A soft-deleted category still sits in `categoryId`; it classifies nothing.
const hasLiveCategory = (t: Product) => sql`EXISTS (
  SELECT 1 FROM "ProductCategory" dq_cat
  WHERE dq_cat."id" = ${t.categoryId} AND dq_cat."deletedAt" IS NULL
)`;

const hasIdentifier = (t: Product) =>
  sql`((${t.model} IS NOT NULL AND trim(${t.model}) <> '') OR ${hasExternalId(t)})`;

const derivedPrice = (t: Product, context?: QualityReadContext) =>
  context?.derivedAlias
    ? sql`${sql.identifier(context.derivedAlias)}."derivedPrice"`
    : derivedPriceFilterSql(t.id);
const hasDerivedPrice = (t: Product, context?: QualityReadContext) =>
  hasDerivedProductPriceSql(t.id, context);

export const productChecks = defineEntityChecks({
  entity: "product",
  table: product,
  derivedRead: productPriceEvidenceSql,
  checks: {
    product_orphaned: { missing: orphanedProductCondition },
    // Identity applies to every Product, spend or stock or neither: a
    // catalog-only entry still earns its name, maker, and category.
    product_name: {
      missing: (t) => sql`trim(${t.name}) = ''`,
      fingerprint: (t) => [sql`${t.name}`],
    },
    product_manufacturer: {
      missing: (t) =>
        sql`(trim(${t.manufacturer}) = '' OR lower(trim(${t.manufacturer})) = lower(${UNSPECIFIED_MANUFACTURER}))`,
      fingerprint: (t) => [sql`${t.manufacturer}`],
    },
    product_external_id: {
      missing: (t) => sql`NOT ${hasIdentifier(t)}`,
      fingerprint: (t) => [hasIdentifier(t)],
    },
    product_category: {
      missing: (t) => sql`NOT ${hasLiveCategory(t)}`,
      fingerprint: (t) => [sql`${t.categoryId}`],
    },
    product_price: {
      // A `misc:` bucket is a heterogeneous pile and is *expected* to be
      // unpriced (the per-location summary makes the same split); a stocked
      // product otherwise carries no value into its location's total. An
      // unstocked Product earns credit for a known price (zero included) but
      // is never charged a gap: its historical price may be unknowable.
      expected: (t, context) =>
        sql`(${hasStock(t)} OR ${t.price} IS NOT NULL OR (${hasDerivedPrice(t, context)})) AND lower(${t.name}) NOT LIKE 'misc:%'`,
      missing: (t, context) =>
        sql`(${t.price} IS NULL AND NOT (${hasDerivedPrice(t, context)}))`,
      fingerprint: (t, context) => [sql`${t.price}`, derivedPrice(t, context)],
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
      expected: hasAmazonPurchase,
      missing: (t) => sql`NOT ${hasAmazonId(t)}`,
      fingerprint: (t) => [hasAmazonPurchase(t), hasAmazonId(t)],
    },
    product_unpurchased: {
      expected: (t) =>
        sql`${hasInventory(t)} AND ${t.acquisitionOrigin} NOT IN ('gift', 'previously_owned')`,
      missing: (t) =>
        sql`NOT (${hasAcquiringExpense(t)} OR ${hasPurchaseProductLink(t)})`,
      fingerprint: (t) => [
        sql`${t.acquisitionOrigin}`,
        hasAcquiringExpense(t),
        hasPurchaseProductLink(t),
      ],
    },
  },
});
