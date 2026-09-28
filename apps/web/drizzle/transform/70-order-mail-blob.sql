-- OrderMailAttachment: pending attachment bytes move from a base64 text column
-- to object storage. `apps/web/scripts/order-mail-attachments-to-r2.ts` uploads
-- each row's bytes to `order-mail-attachment/<id>` and verifies the readback
-- BEFORE this runs; this fragment records the deterministic key and drops the
-- only other copy. Plain DDL/backfill, no BEGIN/COMMIT (one transaction with
-- the other fragments). Trivially passes on an empty database.

ALTER TABLE "OrderMailAttachment" ADD COLUMN "pendingObjectKey" text;

UPDATE "OrderMailAttachment"
  SET "pendingObjectKey" = 'order-mail-attachment/' || "id"
  WHERE "pendingDataBase64Url" IS NOT NULL;

-- Relative check: every row that had bytes now has a key, and no other row does.
DO $$
DECLARE
  had_bytes bigint;
  has_key bigint;
BEGIN
  SELECT count("pendingDataBase64Url"), count("pendingObjectKey")
    INTO had_bytes, has_key
    FROM "OrderMailAttachment";
  IF had_bytes <> has_key THEN
    RAISE EXCEPTION
      'OrderMailAttachment: % rows had base64 bytes but % rows have an object key',
      had_bytes, has_key;
  END IF;
END $$;

ALTER TABLE "OrderMailAttachment" DROP COLUMN "pendingDataBase64Url";
