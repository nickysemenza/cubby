-- Runs: one Run per (actor, channel, hour) of throwaway AI work, the legacy
-- Run relabelled, the Gmail search job folded into its Run, and RunMutation
-- folded into AuditLog. Plain Postgres DDL and backfills, no BEGIN/COMMIT: the
-- caller runs every transform fragment in one transaction. Names match what
-- Drizzle emits for apps/web/src/server/db/schema.ts. Every check below is
-- relative to a snapshot taken here, so it also passes on an empty database.

CREATE TEMP TABLE "_runs_pre" ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM "AiUsage") AS "aiUsage",
  (SELECT count(*) FROM "AuditLog") AS "auditLog",
  (SELECT count(*) FROM "RunMutation" WHERE "auditLogId" IS NULL) AS "unmirrored",
  (SELECT count(*) FROM "VendorMailSearchJob") AS "mailJobs",
  (SELECT count(*) FROM "Run" WHERE "purpose" = 'legacy') AS "legacyRuns",
  (SELECT count(*) FROM "Entity" WHERE "kind" = 'run') AS "runEntities";

-- ---------------------------------------------------------------------------
-- Run: input / progress, and the purpose check without ai_action / legacy
-- ---------------------------------------------------------------------------
ALTER TABLE "Run" ADD COLUMN "input" jsonb;
ALTER TABLE "Run" ADD COLUMN "progress" jsonb;
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";

-- ---------------------------------------------------------------------------
-- ai_action -> one ai_suggest keeper per (actor, channel, UTC hour)
-- ---------------------------------------------------------------------------
-- The group key is the clientKey `aiCallRunInput` computes for the same call
-- (`<channel>:<userId>:<hour>`, no user for the system channel), so a call in
-- an already-migrated hour joins its keeper.
CREATE TEMP TABLE "_runs_ai_action" ON COMMIT DROP AS
SELECT
  k."id",
  -- Partition by the key itself: the system channel omits the actor, so
  -- partitioning by actor could give two keepers the same unique clientKey.
  first_value(k."id") OVER (
    PARTITION BY k."clientKey" ORDER BY k."startedAt", k."id"
  ) AS "keeperId",
  k."clientKey"
FROM (
  SELECT
    r."id",
    r."startedAt",
    r."channel" || ':'
      || CASE WHEN r."channel" = 'system' THEN '' ELSE r."actorUserId" || ':' END
      || to_char(date_trunc('hour', r."startedAt"), 'YYYY-MM-DD"T"HH24') AS "clientKey"
  FROM "Run" r
  WHERE r."purpose" = 'ai_action'
) k;

-- Point every single-column reference to a run being merged at its keeper
-- (AiUsage.runId has no ON DELETE; AuditLog.runId would silently null).
DO $$
DECLARE
  fk record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'f' AND confrelid = '"Run"'::regclass
      AND array_length(conkey, 1) <> 1
  ) THEN
    RAISE EXCEPTION 'A composite foreign key references "Run"; repoint it explicitly';
  END IF;
  FOR fk IN
    SELECT c.conrelid::regclass::text AS "tbl", a.attname AS "col"
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND c.confrelid = '"Run"'::regclass
  LOOP
    EXECUTE format(
      'UPDATE %s AS t SET %I = g."keeperId" FROM "_runs_ai_action" AS g '
      'WHERE t.%I = g."id" AND g."id" <> g."keeperId"',
      fk.tbl, fk.col, fk.col
    );
  END LOOP;
END $$;

UPDATE "Run" AS k
SET "purpose" = 'ai_suggest',
    "clientKey" = agg."clientKey",
    "startedAt" = agg."firstStart",
    "endedAt" = agg."lastEnd"
FROM (
  SELECT g."keeperId", g."clientKey",
         min(r."startedAt") AS "firstStart", max(r."endedAt") AS "lastEnd"
  FROM "_runs_ai_action" g
  JOIN "Run" r ON r."id" = g."id"
  GROUP BY g."keeperId", g."clientKey"
) AS agg
WHERE k."id" = agg."keeperId";

CREATE TEMP TABLE "_runs_dropped" ON COMMIT DROP AS
SELECT "id" FROM "_runs_ai_action" WHERE "id" <> "keeperId";

DELETE FROM "Run" WHERE "id" IN (SELECT "id" FROM "_runs_dropped");

-- The identity trigger tombstones a hard-deleted payload's Entity row; these
-- rows never named anything a person can open, so they go too. Any surviving
-- reference to one fails this DELETE (composite FKs to Entity) and rolls the
-- migration back.
DELETE FROM "Entity"
WHERE "kind" = 'run' AND "id" IN (SELECT "id" FROM "_runs_dropped");

-- ---------------------------------------------------------------------------
-- The legacy Run keeps its usage as ordinary background work
-- ---------------------------------------------------------------------------
UPDATE "Run"
SET "purpose" = 'background', "notes" = 'pre-Run AI usage'
WHERE "purpose" = 'legacy';

-- ---------------------------------------------------------------------------
-- VendorMailSearchJob -> Run.input / Run.progress
-- ---------------------------------------------------------------------------
-- `phase` carries the job's status (the claim state); a rate-limited page's
-- transient error stays in progress, a failed job's error becomes the Run's
-- failure details. `updatedAt` is copied because stale-page recovery reads it.
UPDATE "Run" AS r
SET "purpose" = 'mail_search',
    "input" = jsonb_build_object(
      'after', j."after",
      'searchTerms', to_jsonb(j."searchTerms")
    ),
    "progress" = jsonb_build_object(
      'phase', j."status",
      'pageToken', j."pageToken",
      'nextPageToken', j."nextPageToken",
      'pagesScanned', j."pagesScanned",
      'searched', j."searched",
      'reviewable', j."reviewable"
    ) || CASE
      WHEN j."status" <> 'failed' AND j."error" IS NOT NULL
        THEN jsonb_build_object('error', j."error")
      ELSE '{}'::jsonb
    END,
    "skipped" = j."skipped",
    "dispatchError" = COALESCE(
      r."dispatchError",
      CASE WHEN j."status" = 'failed' THEN j."error" END
    ),
    "updatedAt" = j."updatedAt"
FROM "VendorMailSearchJob" AS j
WHERE j."runId" = r."id";

ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check"
  CHECK ("Run"."purpose" IN ('account_sync', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'background', 'file_import', 'mail_search'));

DROP TABLE "VendorMailSearchJob";

-- ---------------------------------------------------------------------------
-- RunMutation -> AuditLog (carrying the Run's id)
-- ---------------------------------------------------------------------------
-- A mutation that already names its AuditLog row keeps that row; the row learns
-- its Run if it did not carry one. Every other mutation becomes an audit row:
-- the mutation kinds the audit trail cannot express (attach, skip) are
-- updates, and the touched fields are named without values, as the writers do.
UPDATE "AuditLog" AS a
SET "runId" = m."runId"
FROM "RunMutation" AS m
WHERE a."id" = m."auditLogId" AND a."runId" IS NULL;

INSERT INTO "AuditLog" (
  "id", "entityKind", "entityId", "action", "changes", "userId", "channel",
  "oauthClientId", "deviceId", "runId", "createdAt"
)
SELECT
  gen_random_uuid(),
  m."targetKind",
  m."targetId",
  CASE m."mutationKind"
    WHEN 'create' THEN 'create'
    WHEN 'delete' THEN 'delete'
    ELSE 'update'
  END,
  COALESCE(
    (
      SELECT jsonb_object_agg(f."field", jsonb_build_object('from', NULL::jsonb, 'to', NULL::jsonb))
      FROM jsonb_array_elements_text(m."fields") AS f("field")
    ),
    '{}'::jsonb
  ),
  r."actorUserId",
  r."channel",
  r."oauthClientId",
  CASE WHEN EXISTS (SELECT 1 FROM "Device" d WHERE d."id" = r."deviceId")
    THEN r."deviceId" END,
  m."runId",
  m."createdAt"
FROM "RunMutation" AS m
JOIN "Run" AS r ON r."id" = m."runId"
WHERE m."auditLogId" IS NULL;

DROP INDEX "AuditLog_runId_idx";
CREATE INDEX "AuditLog_runId_entityKind_idx" ON "AuditLog" USING btree ("runId","entityKind") WHERE "AuditLog"."runId" IS NOT NULL;

DROP TABLE "RunMutation";

-- ---------------------------------------------------------------------------
-- Relative post-checks
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pre record;
BEGIN
  SELECT * INTO pre FROM "_runs_pre";
  IF (SELECT count(*) FROM "AiUsage") <> pre."aiUsage" THEN
    RAISE EXCEPTION 'AiUsage row count changed during run consolidation';
  END IF;
  IF (SELECT count(*) FROM "AuditLog") <> pre."auditLog" + pre."unmirrored" THEN
    RAISE EXCEPTION 'AuditLog did not grow by exactly the unmirrored RunMutation rows';
  END IF;
  IF (SELECT count(*) FROM "Run" WHERE "purpose" = 'mail_search') <> pre."mailJobs" THEN
    RAISE EXCEPTION 'Every VendorMailSearchJob must become one mail_search Run';
  END IF;
  IF (SELECT count(*) FROM "Run" WHERE "purpose" = 'background' AND "notes" = 'pre-Run AI usage') < pre."legacyRuns" THEN
    RAISE EXCEPTION 'A legacy Run was not relabelled';
  END IF;
  IF (SELECT count(*) FROM "Entity" WHERE "kind" = 'run')
       <> pre."runEntities" - (SELECT count(*) FROM "_runs_dropped") THEN
    RAISE EXCEPTION 'Entity rows for consolidated runs were not deleted (or others were)';
  END IF;
  IF EXISTS (SELECT 1 FROM "AiUsage" u LEFT JOIN "Run" r ON r."id" = u."runId" WHERE r."id" IS NULL) THEN
    RAISE EXCEPTION 'AiUsage names a Run that no longer exists';
  END IF;
END $$;
