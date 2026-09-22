-- ImportRun gains the `photo_inventory` purpose and free-text `notes`;
-- ImportRunTarget gains `imageId`/`position` so a photo-inventory run's
-- worklist rows point at Images. Expand-only: run in Neon BEFORE deploying the
-- commit that ships `packages/schemas/src/entity-definitions/23-importRun.entity.ts`.
-- `db:push` cannot diff CHECK bodies or partial-index predicates, so the
-- constraints are re-created here and `db:push` afterwards should report only
-- the usual gin_trgm_ops / array-default drift.
BEGIN;

ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE "ImportRunTarget"
  ADD COLUMN IF NOT EXISTS "imageId" uuid REFERENCES "Image"(id),
  ADD COLUMN IF NOT EXISTS position integer;

ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_purpose_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_purpose_check"
  CHECK (purpose IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory'));
ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_photo_inventory_no_vendor_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_photo_inventory_no_vendor_check"
  CHECK (purpose <> 'photo_inventory' OR "vendorAccountId" IS NULL);

ALTER TABLE "ImportRunTarget" DROP CONSTRAINT IF EXISTS "ImportRunTarget_exactly_one_target_check";
ALTER TABLE "ImportRunTarget" ADD CONSTRAINT "ImportRunTarget_exactly_one_target_check"
  CHECK ((("purchaseId" IS NOT NULL)::int + ("productId" IS NOT NULL)::int + ("imageId" IS NOT NULL)::int) = 1);
ALTER TABLE "ImportRunTarget" DROP CONSTRAINT IF EXISTS "ImportRunTarget_outcome_check";
ALTER TABLE "ImportRunTarget" ADD CONSTRAINT "ImportRunTarget_outcome_check"
  CHECK (outcome IS NULL OR outcome IN ('replayed', 'raw_evidence_drift', 'semantic_drift', 'enriched', 'unavailable', 'skipped', 'attached'));

CREATE INDEX IF NOT EXISTS "ImportRunTarget_image_idx" ON "ImportRunTarget" ("imageId");
CREATE UNIQUE INDEX IF NOT EXISTS "ImportRunTarget_run_image_key"
  ON "ImportRunTarget" ("runId", "imageId") WHERE "imageId" IS NOT NULL;

COMMIT;

-- Verify: both new columns present, four constraints, two indexes.
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('ImportRun', 'ImportRunTarget') AND column_name IN ('notes', 'imageId', 'position');
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname IN ('ImportRun_purpose_check', 'ImportRun_photo_inventory_no_vendor_check',
                  'ImportRunTarget_exactly_one_target_check', 'ImportRunTarget_outcome_check');
SELECT indexname FROM pg_indexes WHERE indexname IN ('ImportRunTarget_image_idx', 'ImportRunTarget_run_image_key');
