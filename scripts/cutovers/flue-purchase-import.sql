\set ON_ERROR_STOP on

BEGIN;

-- The previous runtime cannot safely resume in the per-run Flue transcript.
UPDATE "ImportRun"
SET
  "status" = 'failed',
  "failureCode" = 'runtime_replaced',
  "endedAt" = COALESCE("endedAt", now()),
  "updatedAt" = now()
WHERE "status" IN ('running', 'paused_auth', 'paused_offline');

-- Let the next hourly dispatcher admit these hunts through startOrResume.
UPDATE "ImportHunt"
SET "state" = 'pending_browser', "updatedAt" = now()
WHERE "state" = 'browser_queued';

ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_status_check";
ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_status_check"
  CHECK ("status" IN (
    'running', 'paused_auth', 'paused_offline', 'needs_review', 'completed', 'failed'
  ));

ALTER TABLE "ImportFinding"
  DROP CONSTRAINT IF EXISTS "ImportFinding_target_check";
ALTER TABLE "ImportFinding"
  ADD CONSTRAINT "ImportFinding_target_check"
  CHECK ("targetType" IN ('purchase', 'expense', 'product', 'import_run'));

CREATE UNIQUE INDEX IF NOT EXISTS "ImportRun_one_active_vendor_account_key"
  ON "ImportRun" ("vendorAccountId")
  WHERE "vendorAccountId" IS NOT NULL
    AND "status" IN ('running', 'paused_auth', 'paused_offline');

COMMIT;

SELECT "status", count(*)
FROM "ImportRun"
GROUP BY "status"
ORDER BY "status";

SELECT indexname
FROM pg_indexes
WHERE indexname = 'ImportRun_one_active_vendor_account_key';
