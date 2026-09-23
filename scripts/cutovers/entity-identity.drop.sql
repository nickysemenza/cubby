-- Drop the storage ADR 0006 replaced: the eight <Entity>Image joins, the cookbook
-- cover and vendor logo columns, Image.targetType/targetId/idempotencyKey, and
-- the Product and Purchase `dataExceptions` columns. The runbook is
-- docs/runbooks/entity-identity-schema.md.
--
-- Safe to run while the ADR 0006 build is serving: schema.ts declares none of
-- these objects. Run it promptly after that deploy: the legacy columns still hold
-- NO ACTION foreign keys into "Image", so until they are gone an image
-- hard-delete that a legacy row still names fails.
--
-- One transaction. The guard refuses to drop anything whose data never reached
-- EntityAttachment or DataException (run entity-identity.catchup.sql first).

BEGIN;

-- Take every lock the drops need before any of them runs, without ever waiting:
-- a waiting lock deadlocks against live reads, which take Product then Image.
-- Each NOWAIT attempt is a subtransaction, so a partial acquisition is
-- released before the retry, and locks from the attempt that succeeds persist.
DO $$
BEGIN
  FOR attempt IN 1..100 LOOP
    BEGIN
      LOCK TABLE "Product", "Purchase", "Cookbook", "Vendor",
        "ProductImage", "LocationImage", "GardenEntryImage", "RecipeImage",
        "MealImage", "TaskImage", "PurchaseImage", "ProjectImage", "Image"
        IN ACCESS EXCLUSIVE MODE NOWAIT;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
  RAISE EXCEPTION 'could not lock the legacy tables in 100 attempts; rerun';
END $$;

DO $$
DECLARE
  missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM (
    SELECT j."productId" AS s, j."imageId" AS i FROM "ProductImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."locationId", j."imageId" FROM "LocationImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."gardenEntryId", j."imageId" FROM "GardenEntryImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."recipeId", j."imageId" FROM "RecipeImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."mealId", j."imageId" FROM "MealImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."taskId", j."imageId" FROM "TaskImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."purchaseId", j."imageId" FROM "PurchaseImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT j."projectId", j."imageId" FROM "ProjectImage" j WHERE j."deletedAt" IS NULL
    UNION ALL SELECT o."id", o."coverImageId" FROM "Cookbook" o WHERE o."coverImageId" IS NOT NULL
    UNION ALL SELECT o."id", o."logoImageId" FROM "Vendor" o WHERE o."logoImageId" IS NOT NULL
  ) legacy
  -- A detach since the cutover soft-deletes the attachment, so any row counts.
  WHERE NOT EXISTS (
    SELECT 1 FROM "EntityAttachment" a
    WHERE a."subjectEntityId" = legacy.s AND a."imageId" = legacy.i
  );
  IF missing > 0 THEN
    RAISE EXCEPTION '% legacy image associations have no EntityAttachment row', missing;
  END IF;

  SELECT count(*) INTO missing FROM (
    SELECT "id", "dataExceptions" FROM "Product"
    UNION ALL SELECT "id", "dataExceptions" FROM "Purchase"
  ) owner
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(owner."dataExceptions", '[]'::jsonb)) x
  WHERE NOT EXISTS (
    SELECT 1 FROM "DataException" d
    WHERE d."entityId" = owner."id" AND d."check" = x->>'check'
  );
  IF missing > 0 THEN
    RAISE EXCEPTION '% legacy data exceptions have no DataException row', missing;
  END IF;
END $$;

DROP TABLE "ProductImage", "LocationImage", "GardenEntryImage", "RecipeImage",
  "MealImage", "TaskImage", "PurchaseImage", "ProjectImage";
ALTER TABLE "Cookbook" DROP COLUMN "coverImageId";
ALTER TABLE "Vendor" DROP COLUMN "logoImageId";
DROP INDEX IF EXISTS "Image_attachment_idempotency_key";
ALTER TABLE "Image" DROP COLUMN "targetType", DROP COLUMN "targetId",
  DROP COLUMN "idempotencyKey";
ALTER TABLE "Product" DROP COLUMN "dataExceptions";
ALTER TABLE "Purchase" DROP COLUMN "dataExceptions";

COMMIT;

-- Verify: no rows.
SELECT c.relname FROM pg_class c
WHERE c.relkind = 'r' AND c.relname IN ('ProductImage', 'LocationImage',
  'GardenEntryImage', 'RecipeImage', 'MealImage', 'TaskImage', 'PurchaseImage',
  'ProjectImage');
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'public' AND (
  (table_name = 'Cookbook' AND column_name = 'coverImageId')
  OR (table_name = 'Vendor' AND column_name = 'logoImageId')
  OR (table_name = 'Image' AND column_name IN ('targetType', 'targetId', 'idempotencyKey'))
  OR (table_name IN ('Product', 'Purchase') AND column_name = 'dataExceptions'));
