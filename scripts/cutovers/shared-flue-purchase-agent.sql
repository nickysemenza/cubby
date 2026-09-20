BEGIN;

-- Run this cutover before `pnpm --dir apps/web db:push`. It expands and
-- backfills the existing run table so Drizzle can safely install the remaining
-- additive tables and columns without manufacturing actor identity.
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "publicId" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "actorUserId" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "actorName" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "actorEmail" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "actorLedgerPartyShortcode" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "actorLedgerPartyName" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "actorLedgerPartyKind" text;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "predecessorRunId" uuid;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "coordinatorModel" text DEFAULT 'gpt-5.6-terra';
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "skillRevision" text DEFAULT 'purchase-import@1';
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "runtimeRevision" text DEFAULT 'flue@1';
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "decisionRevision" integer DEFAULT 1;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "auditedAt" timestamp;
ALTER TABLE "ImportRun" ADD COLUMN IF NOT EXISTS "vendorId" uuid;
ALTER TABLE "ImportHunt" ADD COLUMN IF NOT EXISTS "receiptRunId" uuid;

UPDATE "ImportRun" r
SET
  "publicId" = COALESCE(r."publicId", 'PIR-' || upper(substr(md5(r.id::text), 1, 10))),
  "actorUserId" = COALESCE(r."actorUserId", lp."userId"),
  "actorName" = COALESCE(r."actorName", u.name),
  "actorEmail" = COALESCE(r."actorEmail", u.email),
  "actorLedgerPartyShortcode" = COALESCE(r."actorLedgerPartyShortcode", lp.shortcode),
  "actorLedgerPartyName" = COALESCE(r."actorLedgerPartyName", lp.name),
  "actorLedgerPartyKind" = COALESCE(r."actorLedgerPartyKind", lp.kind),
  "coordinatorModel" = COALESCE(r."coordinatorModel", 'gpt-5.6-terra'),
  "skillRevision" = COALESCE(r."skillRevision", 'purchase-import@1'),
  "runtimeRevision" = COALESCE(r."runtimeRevision", 'flue@1'),
  "decisionRevision" = COALESCE(r."decisionRevision", 1)
FROM "LedgerParty" lp
JOIN "user" u ON u.id = lp."userId"
WHERE lp.id = r."ledgerPartyId";

UPDATE "ImportRun" r
SET "vendorId" = va."vendorId"
FROM "VendorAccount" va
WHERE va.id = r."vendorAccountId"
  AND r."vendorId" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ImportRun"
    WHERE "publicId" IS NULL
       OR "actorUserId" IS NULL
       OR "actorName" IS NULL
       OR "actorEmail" IS NULL
       OR "actorLedgerPartyShortcode" IS NULL
       OR "actorLedgerPartyName" IS NULL
       OR "actorLedgerPartyKind" IS NULL
  ) THEN
    RAISE EXCEPTION 'Every historical ImportRun must belong to a user-linked LedgerParty before cutover';
  END IF;
END $$;

ALTER TABLE "ImportRun" ALTER COLUMN "publicId" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "actorUserId" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "actorName" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "actorEmail" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "actorLedgerPartyShortcode" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "actorLedgerPartyName" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "actorLedgerPartyKind" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "coordinatorModel" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "skillRevision" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "runtimeRevision" SET NOT NULL;
ALTER TABLE "ImportRun" ALTER COLUMN "decisionRevision" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ImportRun_publicId_unique"
  ON "ImportRun" ("publicId");

ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_status_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_status_check"
  CHECK (status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval', 'needs_review', 'completed', 'failed'));

ALTER TABLE "ImportRunOperation" DROP CONSTRAINT IF EXISTS "ImportRunOperation_state_check";
ALTER TABLE "ImportRunOperation" ADD CONSTRAINT "ImportRunOperation_state_check"
  CHECK (state IN ('started', 'paused_approval', 'completed', 'failed'));

-- Fence the replaced coordinator before creating any successors. Browser
-- operation replays are fenced in the same transaction; the broker rejects
-- their stale run/generation if a late client result arrives.
CREATE TEMP TABLE _replaced_purchase_import_runs ON COMMIT DROP AS
SELECT *
FROM "ImportRun"
WHERE status IN ('running', 'paused_auth', 'paused_offline');

UPDATE "ImportRunOperation" o
SET
  state = 'failed',
  error = 'runtime_replaced',
  "completedAt" = now(),
  "updatedAt" = now()
FROM _replaced_purchase_import_runs r
WHERE o."runId" = r.id
  AND o.state = 'started';

UPDATE "ImportRun" r
SET
  status = 'failed',
  "failureCode" = 'runtime_replaced',
  "endedAt" = now(),
  "updatedAt" = now()
FROM _replaced_purchase_import_runs old
WHERE r.id = old.id;

INSERT INTO "ImportRun" (
  id,
  "publicId",
  "ledgerPartyId",
  "actorUserId",
  "actorName",
  "actorEmail",
  "actorLedgerPartyShortcode",
  "actorLedgerPartyName",
  "actorLedgerPartyKind",
  "vendorAccountId",
  "vendorId",
  "predecessorRunId",
  trigger,
  status,
  "coordinatorModel",
  "skillRevision",
  "runtimeRevision",
  "decisionRevision",
  "agentSessionId",
  "startedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  'PIR-' || upper(substr(md5(old.id::text || ':shared-flue'), 1, 10)),
  old."ledgerPartyId",
  old."actorUserId",
  old."actorName",
  old."actorEmail",
  old."actorLedgerPartyShortcode",
  old."actorLedgerPartyName",
  old."actorLedgerPartyKind",
  old."vendorAccountId",
  old."vendorId",
  old.id,
  old.trigger,
  'paused_offline',
  'gpt-5.6-terra',
  'purchase-import@1',
  'flue@1',
  1,
  NULL,
  now(),
  now(),
  now()
FROM _replaced_purchase_import_runs old
WHERE old."vendorAccountId" IS NOT NULL;

UPDATE "ImportRun"
SET "agentSessionId" = 'import-run:' || id::text
WHERE "agentSessionId" IS NULL
  AND "predecessorRunId" IS NOT NULL;

DROP INDEX IF EXISTS "ImportRun_one_active_vendor_account_key";
CREATE UNIQUE INDEX "ImportRun_one_active_vendor_account_key"
  ON "ImportRun" ("vendorAccountId")
  WHERE "vendorAccountId" IS NOT NULL
    AND status IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');

COMMIT;

SELECT status, count(*)
FROM "ImportRun"
GROUP BY status
ORDER BY status;

SELECT count(*) AS runs_missing_public_or_actor_identity
FROM "ImportRun"
WHERE "publicId" IS NULL OR "actorUserId" IS NULL;

SELECT indexname
FROM pg_indexes
WHERE tablename = 'ImportRun'
  AND indexname IN (
    'ImportRun_publicId_unique',
    'ImportRun_one_active_vendor_account_key'
  )
ORDER BY indexname;
