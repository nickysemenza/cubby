-- Run attribution cutover. Every AI call belongs to a Run, and audit rows record
-- the channel, OAuth client, device and run behind each write.
--
-- Apply by hand in Neon during the downtime window, BEFORE deploying the code
-- that reads these columns. Do not use `db:push`: it does not diff CHECK
-- constraints or partial-index predicates, and the dev DATABASE_URL is prod.
-- The final SELECTs must show zero invalid rows and the expected columns.
-- Delete this file after verification.
BEGIN;

-- System actor: only for work with no user present (crons, retries). It has
-- no member party and cannot sign in.
INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('cubby-system', 'Cubby', 'system@cubby.invalid', false, now(), now())
ON CONFLICT (id) DO NOTHING;

-- ImportRun: new purposes, the `ephemeral` trigger, attribution columns.
ALTER TABLE "ImportRun"
  ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS "oauthClientId" text,
  ADD COLUMN IF NOT EXISTS "deviceId" uuid,
  ADD COLUMN IF NOT EXISTS "clientKey" text;

ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_trigger_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_trigger_check"
  CHECK ("trigger" IN ('foreground', 'discovery', 'manual', 'backfill', 'ephemeral'));
ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_purpose_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_purpose_check"
  CHECK ("purpose" IN ('account_sync', 'purchase_validation', 'product_enrichment',
    'photo_inventory', 'ai_suggest', 'ai_action', 'background', 'file_import', 'legacy'));
ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_channel_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_channel_check"
  CHECK ("channel" IN ('web', 'api', 'mcp', 'caldav', 'system'));
-- Runs that group AI work have no member scope; import runs keep requiring it.
ALTER TABLE "ImportRun"
  ALTER COLUMN "ledgerPartyId" DROP NOT NULL,
  ALTER COLUMN "actorLedgerPartyShortcode" DROP NOT NULL,
  ALTER COLUMN "actorLedgerPartyName" DROP NOT NULL,
  ALTER COLUMN "actorLedgerPartyKind" DROP NOT NULL;
ALTER TABLE "ImportRun" DROP CONSTRAINT IF EXISTS "ImportRun_import_party_check";
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_import_party_check"
  CHECK ("purpose" NOT IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory')
    OR ("ledgerPartyId" IS NOT NULL AND "actorLedgerPartyShortcode" IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS "ImportRun_clientKey_unique"
  ON "ImportRun" ("clientKey") WHERE "clientKey" IS NOT NULL;

-- Existing import runs were started through the purchase agent or the app.
UPDATE "ImportRun" SET "channel" = 'api' WHERE "channel" = 'web';

-- The legacy run owns AI usage recorded before every call had a run. The id
-- matches LEGACY_RUN_ID in apps/web/src/server/runs/ensure-run.ts.
INSERT INTO "ImportRun" (
  id, shortcode, "ledgerPartyId", "actorName", purpose, trigger, status,
  "startedAt", "endedAt", "actorUserId", "actorEmail",
  "actorLedgerPartyShortcode", "actorLedgerPartyName", "actorLedgerPartyKind",
  channel, notes
)
VALUES (
  '00000000-0000-4000-8000-00000000c0de', 'RUN-PAST', NULL, 'Cubby',
  'legacy', 'ephemeral', 'completed', now(), now(), 'cubby-system',
  'system@cubby.invalid', NULL, NULL, NULL, 'system',
  'AI usage recorded before every AI call belonged to a run.'
)
ON CONFLICT (id) DO NOTHING;

-- AiUsage.runId: purchase-import usage maps to its real run, the rest to legacy.
ALTER TABLE "AiUsage" ADD COLUMN IF NOT EXISTS "runId" uuid REFERENCES "ImportRun"(id);
UPDATE "AiUsage" u
SET "runId" = r.id
FROM "ImportRun" r
WHERE u."runId" IS NULL
  AND u."jobKind" = 'purchase_import_run'
  AND u."jobId" = r.id::text;
UPDATE "AiUsage"
SET "runId" = '00000000-0000-4000-8000-00000000c0de'
WHERE "runId" IS NULL;
ALTER TABLE "AiUsage" ALTER COLUMN "runId" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "AiUsage_run_idx" ON "AiUsage" ("runId");

-- AuditLog: `source` becomes `channel`, plus client, device and run.
ALTER TABLE "AuditLog"
  ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS "oauthClientId" text,
  ADD COLUMN IF NOT EXISTS "deviceId" uuid REFERENCES "Device"(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "runId" uuid REFERENCES "ImportRun"(id) ON DELETE SET NULL;
UPDATE "AuditLog" SET "channel" = CASE
    WHEN source = 'mcp' THEN 'mcp'
    WHEN source = 'caldav' THEN 'caldav'
    WHEN source = 'api' OR source LIKE 'script:%' THEN 'api'
    ELSE 'web'
  END
WHERE source IS NOT NULL;
ALTER TABLE "AuditLog" DROP COLUMN IF EXISTS source;
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_channel_check";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_channel_check"
  CHECK ("channel" IN ('web', 'api', 'mcp', 'caldav', 'system'));
CREATE INDEX IF NOT EXISTS "AuditLog_runId_idx"
  ON "AuditLog" ("runId") WHERE "runId" IS NOT NULL;

-- Verification: each must return zero, and the legacy run must exist.
SELECT count(*) AS ai_usage_without_run FROM "AiUsage" WHERE "runId" IS NULL;
SELECT count(*) AS legacy_run FROM "ImportRun"
WHERE id = '00000000-0000-4000-8000-00000000c0de';
SELECT table_name, column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('ImportRun', 'channel'), ('ImportRun', 'clientKey'),
    ('AiUsage', 'runId'), ('AuditLog', 'channel'), ('AuditLog', 'runId')
  )
ORDER BY table_name, column_name;

COMMIT;
