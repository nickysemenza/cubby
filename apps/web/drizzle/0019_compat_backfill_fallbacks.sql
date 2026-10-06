ALTER TABLE "EntityAttachment" DROP CONSTRAINT "EntityAttachment_purpose_kind_check";--> statement-breakpoint
ALTER TABLE "EntityExternalId" DROP CONSTRAINT "EntityExternalId_kind_check";--> statement-breakpoint
ALTER TABLE "EntityExternalId" DROP CONSTRAINT "EntityExternalId_primary_check";--> statement-breakpoint
-- Every Product attachment now names its purpose; a null was the original
-- item role.
UPDATE "EntityAttachment" SET "purpose" = 'item' WHERE "entityKind" = 'product' AND "purpose" IS NULL;--> statement-breakpoint
-- An unclassified vendor identifier takes the SKU kind its vendor's other
-- Product identifiers use most, else retailer_sku. Shaped kinds (asin,
-- internet_number, gtin_14) are never inferred from a vendor alone.
UPDATE "EntityExternalId" e SET "kind" = COALESCE((
  SELECT o."kind" FROM "EntityExternalId" o
  WHERE o."source" = e."source" AND o."entityKind" = 'product' AND o."deletedAt" IS NULL
    AND o."kind" IN ('retailer_sku', 'item_number', 'catalog_number')
  GROUP BY o."kind" ORDER BY count(*) DESC, o."kind" LIMIT 1
), 'retailer_sku') WHERE e."kind" = 'legacy_unspecified';--> statement-breakpoint
ALTER TABLE "DataException" ALTER COLUMN "fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "EntityAttachment" ADD CONSTRAINT "EntityAttachment_purpose_kind_check" CHECK (("EntityAttachment"."purpose" IS NOT NULL) = ("EntityAttachment"."entityKind" = 'product'));--> statement-breakpoint
ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_kind_check" CHECK (("entityKind", "kind") IN (('product', 'asin'), ('product', 'retailer_sku'), ('product', 'internet_number'), ('product', 'item_number'), ('product', 'catalog_number'), ('product', 'manufacturer_part'), ('product', 'gtin_14'), ('financialTransaction', 'settlement_ref'), ('expense', 'page'), ('task', 'page'), ('project', 'page'), ('recipe', 'page'), ('project', 'folder')));--> statement-breakpoint
ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_primary_check" CHECK (CASE WHEN "kind" IN ('asin', 'retailer_sku', 'internet_number', 'item_number', 'catalog_number', 'manufacturer_part', 'gtin_14', 'page', 'folder') THEN "isPrimary" IS NOT NULL ELSE "isPrimary" IS NULL END);