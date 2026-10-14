SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '600s';--> statement-breakpoint
-- Authorized breaking cutover: image-job writers are paused; hold the table through commit.
LOCK TABLE "ImageProcessingJob" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT "ImageProcessingJob_kind_check";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT "ImageProcessingJob_state_check";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT "ImageProcessingJob_submissionId_ImageProcessingSubmission_id_fk";
--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT "ImageProcessingJob_runId_Run_id_fk";
--> statement-breakpoint
DROP INDEX "ImageProcessingJob_publicId_key";--> statement-breakpoint
DROP INDEX "ImageProcessingJob_runId_idx";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ALTER COLUMN "publicId" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN "shortcode" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ImageProcessingJob_shortcode_unique" ON "ImageProcessingJob" USING btree ("shortcode");--> statement-breakpoint
-- Each job gets a fresh public code from the shared alphabet; codes are unique
-- across every entity (Entity.shortcode), so a draw taken anywhere redraws.
DO $$
DECLARE
  job record;
  code text;
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
BEGIN
  FOR job IN SELECT id FROM "ImageProcessingJob" WHERE shortcode IS NULL ORDER BY "createdAt", id LOOP
    LOOP
      code := 'IPR-' || (
        SELECT string_agg(substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1), '')
        FROM generate_series(1, 5)
      );
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Entity" WHERE shortcode = code)
        AND NOT EXISTS (SELECT 1 FROM "ImageProcessingJob" WHERE shortcode = code);
    END LOOP;
    UPDATE "ImageProcessingJob" SET shortcode = code WHERE id = job.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ALTER COLUMN "shortcode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN "deletedAt" timestamp;--> statement-breakpoint
-- Widen Entity only now: dropping its checks takes ACCESS EXCLUSIVE on the shared identity
-- table, so the per-job backfill above runs without blocking other entities.
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";--> statement-breakpoint
INSERT INTO "Entity" ("id", "kind", "shortcode", "createdAt", "deletedAt")
SELECT id, 'imageJob', shortcode, "createdAt", NULL FROM "ImageProcessingJob"
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "ImageProcessingJob" job
    LEFT JOIN "Entity" identity ON identity.id = job.id
    WHERE identity.id IS NULL OR identity.kind <> 'imageJob' OR identity.shortcode <> job.shortcode
  ) THEN
    RAISE EXCEPTION 'Image job identity backfill is incomplete or collides with another entity';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_submissionId_ImageProcessingSubmission_id_fk" FOREIGN KEY ("submissionId") REFERENCES "public"."ImageProcessingSubmission"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ImageProcessingJob_imageId_createdAt_idx" ON "ImageProcessingJob" USING btree ("imageId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ImageProcessingJob_derivativeId_idx" ON "ImageProcessingJob" USING btree ("derivativeId");--> statement-breakpoint
CREATE INDEX "ImageProcessingJob_submissionId_idx" ON "ImageProcessingJob" USING btree ("submissionId");--> statement-breakpoint
CREATE INDEX "ImageProcessingJob_runId_idx" ON "ImageProcessingJob" USING btree ("runId");--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email', 'imageJob'));--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' WHEN 'email' THEN "Entity"."shortcode" LIKE 'EML-%' WHEN 'imageJob' THEN "Entity"."shortcode" LIKE 'IPR-%' ELSE false END);--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_kind_check" CHECK ("kind" IN ('subject_lift', 'describe_image', 'identify_image'));--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_state_check" CHECK ("state" IN ('pending', 'waiting_for_device', 'leased', 'ready', 'skipped', 'failed'));