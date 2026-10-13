-- Hold this barrier through consolidation and guard installation in the migration transaction.
LOCK TABLE "DataException" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Apply before deploying the retired check enum: hydration parses every stored
-- exception. Retain the surviving identifier exception's acceptance basis and
-- preserve the retired model record as evidence in its note.
UPDATE "DataException" AS identifier
SET "note" = identifier."note" || E'\n\nFormer model exception: ' || to_jsonb(model_exception)::text
FROM "DataException" AS model_exception
WHERE identifier."entityId" = model_exception."entityId"
  AND identifier."check" = 'product_external_id'
  AND model_exception."check" = 'product_model';
--> statement-breakpoint
DELETE FROM "DataException" AS model_exception
USING "DataException" AS identifier
WHERE identifier."entityId" = model_exception."entityId"
  AND identifier."check" = 'product_external_id'
  AND model_exception."check" = 'product_model';
--> statement-breakpoint
-- A model-only exception does not prove that no external ID is available.
-- Preserve its record but force it stale until the combined gap is reviewed.
UPDATE "DataException"
SET "check" = 'product_external_id',
    "note" = "note" || E'\n\nFormer model exception: ' || to_jsonb("DataException")::text,
    "fingerprint" = 'retired-model:' || "fingerprint"
WHERE "check" = 'product_model';

--> statement-breakpoint
ALTER TABLE "DataException" ADD CONSTRAINT "DataException_no_retired_model_check" CHECK ("DataException"."check" <> 'product_model');