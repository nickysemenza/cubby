-- TEMPORARY: run in Neon only after the expand schema is deployed. The two
-- invalid-row queries must return zero rows and the catalog query must return
-- all four expected indexes. Delete this file after verification and before
-- merge.
--
-- The default is intentional: old ImportRun rows remain account-sync history.
BEGIN;

UPDATE "ImportRun"
SET "purpose" = 'account_sync'
WHERE "purpose" IS NULL;

SELECT id, "publicId", purpose
FROM "ImportRun"
WHERE purpose NOT IN ('account_sync', 'purchase_validation', 'product_enrichment');

SELECT id, "publicId", status
FROM "ImportRun"
WHERE status NOT IN (
  'running', 'paused_auth', 'paused_offline', 'paused_approval',
  'needs_review', 'completed', 'failed', 'dispatch_failed'
);

-- The expand migration owns DDL. These catalog checks prevent a partial deploy
-- from admitting targeted runs without their history/evidence invariants.
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'ImportRun_dispatch_event_unique',
    'ImportRunTarget_run_purchase_key',
    'ImportRunTarget_run_product_key',
    'ImportRunEvidence_object_key_unique'
  )
ORDER BY indexname;

COMMIT;
