-- cubby:transaction-per-statement
-- Each statement is restartable; the runner records this migration only after all batches commit.
DO $$ BEGIN
  ALTER TABLE "Entity" DROP CONSTRAINT IF EXISTS "Entity_kind_check";
  ALTER TABLE "Entity" DROP CONSTRAINT IF EXISTS "Entity_shortcode_prefix_check";
  ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email', 'imageJob', 'sourceTransactionRecord', 'transactionImport', 'job', 'shipment')) NOT VALID;
  ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' WHEN 'email' THEN "Entity"."shortcode" LIKE 'EML-%' WHEN 'imageJob' THEN "Entity"."shortcode" LIKE 'IPR-%' WHEN 'sourceTransactionRecord' THEN "Entity"."shortcode" LIKE 'STR-%' WHEN 'transactionImport' THEN "Entity"."shortcode" LIKE 'TIM-%' WHEN 'job' THEN "Entity"."shortcode" LIKE 'JOB-%' WHEN 'shipment' THEN "Entity"."shortcode" LIKE 'SHIP-%' ELSE false END) NOT VALID;
END $$;
--> statement-breakpoint
ALTER TABLE "Entity" VALIDATE CONSTRAINT "Entity_kind_check", VALIDATE CONSTRAINT "Entity_shortcode_prefix_check";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "Job" ADD COLUMN IF NOT EXISTS "shortcode" text;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Job"'::regclass AND conname = 'Job_shortcode_not_null') THEN
    ALTER TABLE "Job" ADD CONSTRAINT "Job_shortcode_not_null" CHECK ("shortcode" IS NOT NULL) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM "Job" j JOIN "Entity" e ON e.id = j.id WHERE e.kind <> 'job' OR e."deletedAt" IS NOT NULL OR e."mergedIntoId" IS NOT NULL OR e.shortcode !~ '^JOB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$') THEN
    RAISE EXCEPTION 'Job identity conflicts with an existing identity; no execution work was discarded';
  END IF;
END $$;
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "Job_shortcode_unique";
--> statement-breakpoint
-- cubby:outside-transaction
CREATE UNIQUE INDEX CONCURRENTLY "Job_shortcode_unique" ON "Job" (shortcode);
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "Job_shortcode_backfill_idx";
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY "Job_shortcode_backfill_idx" ON "Job" (id) WHERE shortcode IS NULL;
--> statement-breakpoint
-- cubby:repeat-batch
-- A transaction locks at most 1,000 execution rows. Queue state and timestamps never change.
WITH batch AS MATERIALIZED (
  SELECT id, "createdAt" FROM "Job" WHERE shortcode IS NULL ORDER BY id LIMIT 1000 FOR UPDATE
), candidates AS MATERIALIZED (
  SELECT b.id, b."createdAt", coalesce(e.shortcode,
    'JOB-' || (SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',
      1 + (('x' || substr(md5(b.id::text || gen_random_uuid()::text), 1 + 2 * letter, 2))::bit(8)::int % length('23456789ABCDEFGHJKMNPQRSTUVWXYZ')), 1), '')
      FROM generate_series(0, 9) letter)) AS shortcode
  FROM batch b LEFT JOIN "Entity" e ON e.id = b.id AND e.kind = 'job'
), inserted AS (
  INSERT INTO "Entity" (id, kind, shortcode, "createdAt")
    SELECT id, 'job', shortcode, "createdAt" FROM candidates
    ON CONFLICT DO NOTHING RETURNING id, shortcode
), filled AS (
  UPDATE "Job" j SET shortcode = identity.shortcode FROM (
    SELECT id, shortcode FROM inserted UNION ALL
    SELECT e.id, e.shortcode FROM "Entity" e JOIN batch b ON b.id = e.id WHERE e.kind = 'job'
  ) identity WHERE j.id = identity.id AND j.shortcode IS NULL RETURNING j.id
)
SELECT EXISTS (SELECT 1 FROM batch) AS remaining;
--> statement-breakpoint
ALTER TABLE "Job" VALIDATE CONSTRAINT "Job_shortcode_not_null";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "Job" ALTER COLUMN shortcode SET NOT NULL;
  ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_shortcode_not_null";
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"Job"'::regclass AND conname = 'Job_entity_identity_fk') THEN
    ALTER TABLE "Job" ADD CONSTRAINT "Job_entity_identity_fk" FOREIGN KEY (id, shortcode) REFERENCES "Entity" (id, shortcode) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "Job" VALIDATE CONSTRAINT "Job_entity_identity_fk";
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "Job_shortcode_backfill_idx";
