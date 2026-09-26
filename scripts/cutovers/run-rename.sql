-- Big-bang cutover: ImportRun -> Run, entity kind importRun -> run, plus the
-- schema deltas that ship with it. Runbook: docs/runbooks/run-rename-cutover.md.
-- Run in Neon IMMEDIATELY BEFORE merging the PR that renames the schema; the
-- old deploy errors against the renamed tables until the new one is live.
-- One transaction: any failed assertion rolls everything back.
BEGIN;

-- 0. A competing lock fails fast instead of stretching the window.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';

-- Active runs (running or paused) straddle the API shape change: their Flue
-- instance and browser commands speak the old names. Fail them so they can be
-- restarted from the run page afterwards; `needs_review` runs are plain data.
UPDATE "ImportRun"
SET status = 'failed',
    "failureCode" = 'run_cutover',
    "endedAt" = now(),
    "updatedAt" = now()
WHERE status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');

UPDATE "VendorAccount"
SET status = 'active', "updatedAt" = now()
WHERE status IN ('paused_auth', 'paused_offline');

-- 1. Tables.
ALTER TABLE "ImportRun" RENAME TO "Run";
ALTER TABLE "ImportRunTarget" RENAME TO "RunTarget";
ALTER TABLE "ImportRunOrderCandidate" RENAME TO "RunOrderCandidate";
ALTER TABLE "ImportRunEvidence" RENAME TO "RunEvidence";
ALTER TABLE "ImportRunMutation" RENAME TO "RunMutation";
ALTER TABLE "ImportRunOperation" RENAME TO "RunOperation";
ALTER TABLE "ImportRunProgress" RENAME TO "RunProgress";
ALTER TABLE "ImportRunControlEvent" RENAME TO "RunControlEvent";
ALTER TABLE "ImportRunApproval" RENAME TO "RunApproval";
ALTER TABLE "ImportFinding" RENAME TO "RunFinding";

-- 2. Columns.
ALTER TABLE "Purchase" RENAME COLUMN "importRunId" TO "runId";
ALTER TABLE "RunFinding" RENAME COLUMN "importRunId" TO "runId";

-- 3. Constraint and index names follow the tables (Drizzle derives FK names
--    from table and column names, so every old spelling must go).
DO $$
DECLARE
  r record;
  renamed text;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, con.conname AS name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND con.conname ~ '(ImportRun|importRunId|ImportFinding)'
  LOOP
    renamed := replace(replace(replace(r.name, 'ImportFinding', 'RunFinding'),
      'importRunId', 'runId'), 'ImportRun', 'Run');
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.name, renamed);
  END LOOP;
  FOR r IN
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname ~ '(ImportRun|importRunId|ImportFinding)'
  LOOP
    renamed := replace(replace(replace(r.name, 'ImportFinding', 'RunFinding'),
      'importRunId', 'runId'), 'ImportRun', 'Run');
    EXECUTE format('ALTER INDEX %I RENAME TO %I', r.name, renamed);
  END LOOP;
END $$;

-- 4. Entity kind importRun -> run. No composite (id, kind) FK row points at a
--    run today (AuditLog, SearchDocument, EntityEmbedding, DataException all
--    hold zero), so the key update has nothing to cascade.
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";
UPDATE "Entity" SET kind = 'run' WHERE kind = 'importRun';
UPDATE "McpToolCall" SET entity = 'run' WHERE entity = 'importRun';
-- Re-added with the post-rename vocabulary (generated from SHORTCODE_PREFIX;
-- keep in sync with apps/web/src/server/db/entity-identity-schema.ts).
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK (kind = ANY (ARRAY[
  'product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory',
  'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor',
  'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense',
  'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory',
  'run', 'device', 'imageSighting', 'plant'
]::text[]));
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK (
  shortcode IS NULL OR CASE kind
    WHEN 'product' THEN shortcode LIKE 'PRD-%'
    WHEN 'recipe' THEN shortcode LIKE 'RCP-%'
    WHEN 'ingredient' THEN shortcode LIKE 'ING-%'
    WHEN 'cookbook' THEN shortcode LIKE 'CKB-%'
    WHEN 'location' THEN shortcode LIKE 'LOC-%'
    WHEN 'inventory' THEN shortcode LIKE 'INV-%'
    WHEN 'meal' THEN shortcode LIKE 'MEL-%'
    WHEN 'ledgerParty' THEN shortcode LIKE 'LPY-%'
    WHEN 'ledgerTransfer' THEN shortcode LIKE 'LTR-%'
    WHEN 'project' THEN shortcode LIKE 'PRJ-%'
    WHEN 'task' THEN shortcode LIKE 'TSK-%'
    WHEN 'vendor' THEN shortcode LIKE 'VEN-%'
    WHEN 'purchase' THEN shortcode LIKE 'PUR-%'
    WHEN 'financialAccount' THEN shortcode LIKE 'FAC-%'
    WHEN 'financialTransaction' THEN shortcode LIKE 'FTX-%'
    WHEN 'wish' THEN shortcode LIKE 'WSH-%'
    WHEN 'expense' THEN shortcode LIKE 'EXP-%'
    WHEN 'image' THEN shortcode LIKE 'IMG-%'
    WHEN 'planting' THEN shortcode LIKE 'PLT-%'
    WHEN 'gardenEntry' THEN shortcode LIKE 'GDE-%'
    WHEN 'vendorAccount' THEN shortcode LIKE 'VACCT-%'
    WHEN 'productCategory' THEN shortcode LIKE 'CAT-%'
    WHEN 'run' THEN shortcode LIKE 'RUN-%'
    WHEN 'device' THEN shortcode LIKE 'DEV-%'
    WHEN 'imageSighting' THEN shortcode LIKE 'IMS-%'
    WHEN 'plant' THEN shortcode LIKE 'PLANT-%'
    ELSE false
  END
);

DROP TRIGGER "Entity_identity_insert" ON "Run";
CREATE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Run"
  FOR EACH ROW EXECUTE FUNCTION entity_identity_on_insert('run');

-- 5. A finding that targets its own run names the entity kind.
ALTER TABLE "RunFinding" DROP CONSTRAINT "RunFinding_target_check";
UPDATE "RunFinding" SET "targetType" = 'run' WHERE "targetType" = 'import_run';
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_target_check"
  CHECK ("targetType" IN ('purchase', 'expense', 'product', 'run'));

-- ============================================================
-- 1. Polymorphic refs anchored on Entity (§2)
-- ============================================================

-- RunFinding.targetType -> targetKind (value set unchanged: it already reads
-- 'purchase' | 'expense' | 'product' | 'run' after the §1 rename).
ALTER TABLE "RunFinding" RENAME COLUMN "targetType" TO "targetKind";

ALTER TABLE "RunFinding"
  ADD CONSTRAINT "RunFinding_target_fk"
    FOREIGN KEY ("targetId", "targetKind")
    REFERENCES "Entity" ("id", "kind")
    NOT VALID;

-- RunMutation.targetType -> targetKind.
ALTER TABLE "RunMutation" RENAME COLUMN "targetType" TO "targetKind";

ALTER TABLE "RunMutation"
  ADD CONSTRAINT "RunMutation_target_fk"
    FOREIGN KEY ("targetId", "targetKind")
    REFERENCES "Entity" ("id", "kind")
    NOT VALID;

-- AiUsage.entityType -> entityKind. One known orphan (an ingredient whose
-- Entity row no longer resolves) is nulled out so the new FK can validate;
-- MATCH SIMPLE then passes it (and every other null-entity usage row) for
-- free.
ALTER TABLE "AiUsage" RENAME COLUMN "entityType" TO "entityKind";

UPDATE "AiUsage" a
SET "entityId" = NULL, "entityKind" = NULL
WHERE a."entityId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Entity" e
    WHERE e."id" = a."entityId" AND e."kind" = a."entityKind"
  );

ALTER TABLE "AiUsage"
  ADD CONSTRAINT "AiUsage_entity_fk"
    FOREIGN KEY ("entityId", "entityKind")
    REFERENCES "Entity" ("id", "kind")
    NOT VALID;

-- AiAnalysis.entityType -> entityKind, plus the value-set and global<->null
-- checks the column never had, and the same composite FK (the 'global'
-- rows' null entityId also passes under MATCH SIMPLE).
ALTER TABLE "AiAnalysis" RENAME COLUMN "entityType" TO "entityKind";

-- Preflight must confirm this is zero before the cutover runs; a nonzero
-- count means a legacy row needs its own repair, not this blanket check.
UPDATE "AiAnalysis"
SET "entityId" = NULL
WHERE "entityKind" = 'global' AND "entityId" IS NOT NULL;

ALTER TABLE "AiAnalysis"
  ADD CONSTRAINT "AiAnalysis_entityKind_check"
    CHECK ("entityKind" IN ('image', 'location', 'product', 'recipe', 'global'))
    NOT VALID;

ALTER TABLE "AiAnalysis"
  ADD CONSTRAINT "AiAnalysis_global_check"
    CHECK (("entityKind" = 'global') = ("entityId" IS NULL))
    NOT VALID;

ALTER TABLE "AiAnalysis"
  ADD CONSTRAINT "AiAnalysis_entity_fk"
    FOREIGN KEY ("entityId", "entityKind")
    REFERENCES "Entity" ("id", "kind")
    NOT VALID;

-- ============================================================
-- 2. Meal amount contract (§3) — runbook §2 backfill, then §3 contract.
-- ============================================================

-- §2 backfill (idempotent): fold any remaining grams-only rows into the
-- canonical {value, unit:"g"} shape before the columns are dropped.
UPDATE "MealFoodEntry"
SET "amount" = jsonb_build_object('value', "grams", 'unit', 'g'),
    "grams" = NULL
WHERE "amount" IS NULL AND "grams" IS NOT NULL;

UPDATE "MealRecipePortion"
SET "amount" = jsonb_build_object('value', "grams", 'unit', 'g'),
    "grams" = NULL
WHERE "amount" IS NULL AND "grams" IS NOT NULL;

-- Preflight must confirm all four are zero before this transaction runs;
-- abort rather than proceed if any is nonzero (an old writer is still live).
DO $$
DECLARE
  legacy_food_entries int;
  missing_required_food_amounts int;
  legacy_recipe_portions int;
  missing_recipe_portion_amounts int;
BEGIN
  SELECT count(*) INTO legacy_food_entries
    FROM "MealFoodEntry" WHERE "grams" IS NOT NULL;
  SELECT count(*) INTO missing_required_food_amounts
    FROM "MealFoodEntry"
    WHERE "sourceKind" IN ('ingredient', 'product') AND "amount" IS NULL;
  SELECT count(*) INTO legacy_recipe_portions
    FROM "MealRecipePortion" WHERE "grams" IS NOT NULL;
  SELECT count(*) INTO missing_recipe_portion_amounts
    FROM "MealRecipePortion" WHERE "amount" IS NULL;
  IF legacy_food_entries <> 0 OR missing_required_food_amounts <> 0
    OR legacy_recipe_portions <> 0 OR missing_recipe_portion_amounts <> 0
  THEN
    RAISE EXCEPTION
      'meal amount backfill incomplete: legacy_food_entries=%, missing_required_food_amounts=%, legacy_recipe_portions=%, missing_recipe_portion_amounts=%',
      legacy_food_entries, missing_required_food_amounts, legacy_recipe_portions, missing_recipe_portion_amounts;
  END IF;
END
$$;

-- §3 contract: drop the grams columns and their compatibility checks, and
-- re-add the checks/NOT NULL for the amount-only shape (matches schema.ts).
ALTER TABLE "MealFoodEntry"
  DROP CONSTRAINT IF EXISTS "MealFoodEntry_grams_check",
  DROP CONSTRAINT IF EXISTS "MealFoodEntry_amount_compatibility_check",
  DROP CONSTRAINT "MealFoodEntry_source_check",
  DROP COLUMN "grams",
  ADD CONSTRAINT "MealFoodEntry_source_check" CHECK (
    ("sourceKind" = 'ingredient'
      AND "ingredientId" IS NOT NULL AND "productId" IS NULL
      AND "amount" IS NOT NULL
      AND "name" IS NULL AND "nutrients" IS NULL)
    OR ("sourceKind" = 'product'
      AND "ingredientId" IS NULL AND "productId" IS NOT NULL
      AND "amount" IS NOT NULL
      AND "name" IS NULL AND "nutrients" IS NULL)
    OR ("sourceKind" = 'manual'
      AND "ingredientId" IS NULL AND "productId" IS NULL
      AND "name" IS NOT NULL AND length(trim("name")) > 0
      AND "nutrients" IS NOT NULL
      AND jsonb_typeof("nutrients") = 'object'
      AND "nutrients" <> '{}'::jsonb)
  ) NOT VALID;

ALTER TABLE "MealRecipePortion"
  DROP CONSTRAINT IF EXISTS "MealRecipePortion_grams_check",
  DROP CONSTRAINT IF EXISTS "MealRecipePortion_amount_source_check",
  DROP COLUMN "grams",
  ALTER COLUMN "amount" SET NOT NULL;

-- ============================================================
-- 3. Actor/run attribution for queued image processing (§4)
-- ============================================================

ALTER TABLE "ImageProcessingJob"
  ADD COLUMN "runId" uuid,
  ADD CONSTRAINT "ImageProcessingJob_runId_Run_id_fk"
    FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE SET NULL;

CREATE INDEX "ImageProcessingJob_runId_idx"
  ON "ImageProcessingJob" ("runId")
  WHERE "runId" IS NOT NULL;

-- ============================================================
-- 4. Photo-run device work (§5)
-- ============================================================

ALTER TABLE "RunTarget"
  ADD COLUMN "deviceWorkState" text,
  ADD COLUMN "deviceWorkAttempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "deviceWorkError" text,
  ADD COLUMN "deviceWorkDeviceId" uuid,
  ADD COLUMN "deviceWorkUpdatedAt" timestamp,
  ADD CONSTRAINT "RunTarget_deviceWorkDeviceId_Device_id_fk"
    FOREIGN KEY ("deviceWorkDeviceId") REFERENCES "Device" ("id") ON DELETE SET NULL;

ALTER TABLE "RunTarget"
  ADD CONSTRAINT "RunTarget_deviceWorkState_check"
    CHECK ("deviceWorkState" IS NULL OR "deviceWorkState" IN
      ('queued', 'running', 'paused', 'failed', 'completed'))
    NOT VALID;

CREATE INDEX "RunTarget_deviceWorkDeviceId_idx"
  ON "RunTarget" ("deviceWorkDeviceId")
  WHERE "deviceWorkDeviceId" IS NOT NULL;

-- 6. Nutrition totals: deleted recipes still cache the pre-2026-09 flattened
--    JSON. Totals are derived and deleted recipes are never recomputed, so
--    clearing them is the whole fix; live recipes already use the new shape.
UPDATE "Recipe" SET "totals" = NULL, "totalsComputedAt" = NULL
WHERE "deletedAt" IS NOT NULL;


-- Validate the constraints added NOT VALID above. The tables are small and
-- the window is already down, so validation stays inside the transaction.
ALTER TABLE "RunFinding" VALIDATE CONSTRAINT "RunFinding_target_fk";
ALTER TABLE "RunMutation" VALIDATE CONSTRAINT "RunMutation_target_fk";
ALTER TABLE "AiUsage" VALIDATE CONSTRAINT "AiUsage_entity_fk";
ALTER TABLE "AiAnalysis" VALIDATE CONSTRAINT "AiAnalysis_entityKind_check";
ALTER TABLE "AiAnalysis" VALIDATE CONSTRAINT "AiAnalysis_global_check";
ALTER TABLE "AiAnalysis" VALIDATE CONSTRAINT "AiAnalysis_entity_fk";
ALTER TABLE "MealFoodEntry" VALIDATE CONSTRAINT "MealFoodEntry_source_check";
ALTER TABLE "RunTarget" VALIDATE CONSTRAINT "RunTarget_deviceWorkState_check";

COMMIT;
