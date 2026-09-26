-- Big-bang cutover: ImportRun -> Run, entity kind importRun -> run, plus the
-- schema deltas that ship with it. Runbook: docs/runbooks/run-rename-cutover.md.
-- Run in Neon IMMEDIATELY BEFORE merging the PR that renames the schema; the
-- old deploy errors against the renamed tables until the new one is live.
-- One transaction: any failed assertion rolls everything back.
BEGIN;

-- 0. Preconditions. No run may be mid-flight: its Flue instance and browser
--    commands still speak the old API shape.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ImportRun" WHERE status = 'running') THEN
    RAISE EXCEPTION 'cutover: a run is still running; wait for it or cancel it';
  END IF;
END $$;

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

-- @@LANE_A@@ (polymorphic FKs, meal grams, attribution, device work)

-- 6. Nutrition totals: deleted recipes still cache the pre-2026-09 flattened
--    JSON. Totals are derived and deleted recipes are never recomputed, so
--    clearing them is the whole fix; live recipes already use the new shape.
UPDATE "Recipe" SET "totals" = NULL, "totalsComputedAt" = NULL
WHERE "deletedAt" IS NOT NULL;

COMMIT;
