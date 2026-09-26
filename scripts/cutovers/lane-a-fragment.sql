-- Lane A schema deltas for the Run-rename big-bang cutover.
-- This fragment is NOT applied standalone: the main agent folds it into
-- scripts/cutovers/run-rename-cutover.sql (after the §1 rename has already
-- landed the Run/RunTarget/RunFinding/RunMutation table and column names, and
-- Entity.kind = 'run'), in the order below. It targets the post-rename
-- schema, so every "Run…" identifier here already exists.
--
-- Sections:
--   1. §2 polymorphic refs: rename targetType/entityType -> targetKind/
--      entityKind on RunFinding, RunMutation, AiUsage, AiAnalysis; add their
--      composite FKs to Entity(id, kind); null out the one AiUsage orphan.
--   2. §3 meal amount contract: backfill the last grams-only rows, then drop
--      grams and its compatibility checks (docs/runbooks/meal-food-entry-schema.md
--      §2/§3, now deleted from the repo — its content lives here instead).
--   3. §4 actor attribution: nullable ImageProcessingJob.runId -> Run.
--   4. §5 device work: RunTarget device-work columns.
--
-- Preflight (run first, outside this transaction): confirm the orphan count
-- and the grams-only counts below match what the preflight script reported,
-- and that no `running` run holds a RunFinding/RunMutation this fragment's
-- rename would touch mid-write (the §1 preflight already gates this).

BEGIN;

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
  ADD COLUMN "runId" uuid REFERENCES "Run" ("id") ON DELETE SET NULL;

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
  ADD COLUMN "deviceWorkDeviceId" uuid REFERENCES "Device" ("id") ON DELETE SET NULL,
  ADD COLUMN "deviceWorkUpdatedAt" timestamp;

ALTER TABLE "RunTarget"
  ADD CONSTRAINT "RunTarget_deviceWorkState_check"
    CHECK ("deviceWorkState" IS NULL OR "deviceWorkState" IN
      ('queued', 'running', 'paused', 'failed', 'completed'))
    NOT VALID;

CREATE INDEX "RunTarget_deviceWorkDeviceId_idx"
  ON "RunTarget" ("deviceWorkDeviceId")
  WHERE "deviceWorkDeviceId" IS NOT NULL;

COMMIT;

-- Validate every NOT VALID constraint added above outside the main
-- transaction, so the exclusive lock the ADD CONSTRAINT took is released
-- before the (potentially slow) full-table scan.
ALTER TABLE "RunFinding" VALIDATE CONSTRAINT "RunFinding_target_fk";
ALTER TABLE "RunMutation" VALIDATE CONSTRAINT "RunMutation_target_fk";
ALTER TABLE "AiUsage" VALIDATE CONSTRAINT "AiUsage_entity_fk";
ALTER TABLE "AiAnalysis" VALIDATE CONSTRAINT "AiAnalysis_entityKind_check";
ALTER TABLE "AiAnalysis" VALIDATE CONSTRAINT "AiAnalysis_global_check";
ALTER TABLE "AiAnalysis" VALIDATE CONSTRAINT "AiAnalysis_entity_fk";
ALTER TABLE "MealFoodEntry" VALIDATE CONSTRAINT "MealFoodEntry_source_check";
ALTER TABLE "RunTarget" VALIDATE CONSTRAINT "RunTarget_deviceWorkState_check";

-- Verify (read back, not applied): confirm neither meal table has "grams",
-- every RunFinding/RunMutation/AiUsage/AiAnalysis row with a non-null
-- entity/target passes its FK, and RunTarget's new columns default correctly
-- for every existing row (deviceWorkState NULL, deviceWorkAttempts 0).
