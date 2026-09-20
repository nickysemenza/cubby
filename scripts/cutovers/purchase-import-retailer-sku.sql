-- Run after deploying the purchase-import writer that records retailer_sku,
-- with purchase imports quiesced for the duration of this transaction. The
-- old writer used the unsupported kind "sku", which makes Product API reads
-- reject otherwise-valid imported rows.
BEGIN;

CREATE TEMP TABLE purchase_import_sku_slots ON COMMIT DROP AS
SELECT DISTINCT "productId", "source"
FROM "ProductExternalId"
WHERE "kind" = 'sku' AND "deletedAt" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ProductExternalId" legacy
    JOIN "ProductExternalId" canonical
      ON canonical."source" = legacy."source"
     AND canonical."kind" = 'retailer_sku'
     AND canonical."externalId" = legacy."externalId"
     AND canonical."deletedAt" IS NULL
    WHERE legacy."kind" = 'sku'
      AND legacy."deletedAt" IS NULL
      AND canonical."productId" <> legacy."productId"
  ) THEN
    RAISE EXCEPTION 'retailer_sku cutover found an identifier claimed by two live Products';
  END IF;
END $$;

-- When the same Product already has the canonical row, keep that row and
-- retire the invalid duplicate. Preserve a useful URL learned by either path.
UPDATE "ProductExternalId" canonical
SET "url" = COALESCE(canonical."url", legacy."url"),
    "updatedAt" = NOW()
FROM "ProductExternalId" legacy
WHERE legacy."kind" = 'sku'
  AND legacy."deletedAt" IS NULL
  AND canonical."kind" = 'retailer_sku'
  AND canonical."deletedAt" IS NULL
  AND canonical."productId" = legacy."productId"
  AND canonical."source" = legacy."source"
  AND canonical."externalId" = legacy."externalId";

UPDATE "ProductExternalId" legacy
SET "deletedAt" = NOW(), "updatedAt" = NOW()
WHERE legacy."kind" = 'sku'
  AND legacy."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "ProductExternalId" canonical
    WHERE canonical."kind" = 'retailer_sku'
      AND canonical."deletedAt" IS NULL
      AND canonical."productId" = legacy."productId"
      AND canonical."source" = legacy."source"
      AND canonical."externalId" = legacy."externalId"
  );

-- The canonical slot may already have a primary. Demote every legacy row in
-- that slot before changing its kind so the partial unique index never sees
-- two live primaries, while retaining distinct identifiers as secondaries.
UPDATE "ProductExternalId" legacy
SET "isPrimary" = FALSE, "updatedAt" = NOW()
WHERE legacy."kind" = 'sku'
  AND legacy."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "ProductExternalId" canonical
    WHERE canonical."productId" = legacy."productId"
      AND canonical."source" = legacy."source"
      AND canonical."kind" = 'retailer_sku'
      AND canonical."isPrimary"
      AND canonical."deletedAt" IS NULL
  );

UPDATE "ProductExternalId"
SET "kind" = 'retailer_sku', "updatedAt" = NOW()
WHERE "kind" = 'sku';

-- Repair a pre-existing zero-primary slot defensively by promoting its oldest
-- live identifier. Normal Product writes enforce the same invariant.
WITH ranked AS (
  SELECT external_id."id",
         ROW_NUMBER() OVER (
           PARTITION BY external_id."productId", external_id."source"
           ORDER BY external_id."createdAt", external_id."id"
         ) AS rank
  FROM "ProductExternalId" external_id
  JOIN purchase_import_sku_slots slot
    ON slot."productId" = external_id."productId"
   AND slot."source" = external_id."source"
  WHERE external_id."kind" = 'retailer_sku'
    AND external_id."deletedAt" IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "ProductExternalId" primary_id
      WHERE primary_id."productId" = external_id."productId"
        AND primary_id."source" = external_id."source"
        AND primary_id."kind" = 'retailer_sku'
        AND primary_id."isPrimary"
        AND primary_id."deletedAt" IS NULL
    )
)
UPDATE "ProductExternalId" external_id
SET "isPrimary" = TRUE, "updatedAt" = NOW()
FROM ranked
WHERE ranked."id" = external_id."id" AND ranked.rank = 1;

COMMIT;

SELECT "kind", COUNT(*) AS row_count
FROM "ProductExternalId"
WHERE "kind" IN ('sku', 'retailer_sku')
GROUP BY "kind"
ORDER BY "kind";

SELECT COUNT(*) AS live_retailer_slots_without_one_primary
FROM (
  SELECT "productId", "source"
  FROM "ProductExternalId"
  WHERE "kind" = 'retailer_sku' AND "deletedAt" IS NULL
  GROUP BY "productId", "source"
  HAVING COUNT(*) FILTER (WHERE "isPrimary") <> 1
) invalid_slots;
