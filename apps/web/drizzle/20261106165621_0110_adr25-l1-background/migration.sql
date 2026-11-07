-- Direct ADR 0025 cutover. Job results are execution receipts, with outcomes on
-- their domain owners. waitUntil duplicates availability; retain its later deadline.
SET LOCAL lock_timeout = '2s';
LOCK TABLE "Job", "DerivedRebuild", "AppSettings" IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE l1_job_preimage ON COMMIT DROP AS SELECT * FROM "Job";
CREATE TEMP TABLE l1_rebuild_preimage ON COMMIT DROP AS SELECT * FROM "DerivedRebuild";

-- Discovery owns its cursor. Preserve the legacy Run launch and terminal/member stops.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Job" WHERE kind = 'discovery.connections' AND key <> 'discovery:connections') THEN
    RAISE EXCEPTION 'Unrecognized connection discovery cursor owner';
  END IF;
  IF EXISTS (SELECT 1 FROM "AppSettings" WHERE id = '0553199e-d21b-4325-8c52-cfb28fc26a2f') THEN
    RAISE EXCEPTION 'Connection discovery cursor destination already occupied';
  END IF;
END $$;
INSERT INTO "AppSettings" (id, metadata)
SELECT '0553199e-d21b-4325-8c52-cfb28fc26a2f'::uuid,
  jsonb_build_object('after', cursor->'after', 'runId', cursor->'runId',
    'nextAt', to_char(greatest("availableAt", "waitUntil", "leaseExpiresAt"), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'stopped', state IN ('paused', 'failed', 'cancelled'), 'error', error)
FROM "Job" WHERE kind = 'discovery.connections';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Job" j LEFT JOIN "AppSettings" s ON s.id = '0553199e-d21b-4325-8c52-cfb28fc26a2f'
    WHERE j.kind = 'discovery.connections' AND s.metadata IS DISTINCT FROM
      jsonb_build_object('after', j.cursor->'after', 'runId', j.cursor->'runId',
        'nextAt', to_char(greatest(j."availableAt", j."waitUntil", j."leaseExpiresAt"), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'stopped', j.state IN ('paused', 'failed', 'cancelled'), 'error', j.error)) THEN
    RAISE EXCEPTION 'Connection discovery cursor preservation failed';
  END IF;
END $$;
UPDATE "Job" SET "availableAt" = greatest("availableAt", "waitUntil");
DELETE FROM "Job" WHERE kind IN ('derived.drain', 'derived.reconcile', 'jobs.maintenance', 'discovery.connections');
-- The old derived handlers only settled retired tickets. Retained deterministic
-- cursors and every existing publication remain unchanged; cron owns future passes.
--> statement-breakpoint
ALTER TABLE "Job" DROP CONSTRAINT "Job_kind_retired_check";--> statement-breakpoint
ALTER TABLE "DerivedRebuild" ADD COLUMN "lastMovementAt" timestamp;--> statement-breakpoint
ALTER TABLE "DerivedRebuild" ADD COLUMN "cleanAt" timestamp;--> statement-breakpoint
ALTER TABLE "DerivedRebuild" ADD COLUMN "pages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "DerivedRebuild" ADD COLUMN "processedRecords" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "DerivedRebuild" ADD COLUMN "failedPages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "DerivedRebuild" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN "waitUntil";--> statement-breakpoint
ALTER TABLE "Job" DROP COLUMN "result";--> statement-breakpoint
ALTER TABLE "Job" ADD CONSTRAINT "Job_kind_retired_check" CHECK ("Job"."kind" NOT IN ('image.cloud', 'image.device', 'image.device.wake', 'embedding.refresh', 'embedding.cleanup', 'ai.evaluation', 'assessment.correction', 'ai-refresh.activate', 'derived.drain', 'derived.reconcile', 'jobs.maintenance', 'discovery.connections'));
--> statement-breakpoint
UPDATE "DerivedRebuild" SET "lastMovementAt" = coalesce("finishedAt", "startedAt", "createdAt");
DO $$ BEGIN
  IF EXISTS (
    (SELECT to_jsonb(old) - 'waitUntil' - 'result' - 'availableAt' || jsonb_build_object('availableAt', greatest(old."availableAt", old."waitUntil"))
      FROM l1_job_preimage old WHERE kind NOT IN ('derived.drain', 'derived.reconcile', 'jobs.maintenance', 'discovery.connections')
     EXCEPT ALL SELECT to_jsonb(current) FROM "Job" current)
    UNION ALL
    (SELECT to_jsonb(current) FROM "Job" current EXCEPT ALL
     SELECT to_jsonb(old) - 'waitUntil' - 'result' - 'availableAt' || jsonb_build_object('availableAt', greatest(old."availableAt", old."waitUntil"))
      FROM l1_job_preimage old WHERE kind NOT IN ('derived.drain', 'derived.reconcile', 'jobs.maintenance', 'discovery.connections'))
  ) THEN RAISE EXCEPTION 'Retained Job preservation failed'; END IF;
  IF EXISTS (
    (SELECT to_jsonb(old) FROM l1_rebuild_preimage old EXCEPT ALL
      SELECT to_jsonb(current) - ARRAY['lastMovementAt', 'cleanAt', 'pages', 'processedRecords', 'failedPages', 'history'] FROM "DerivedRebuild" current)
    UNION ALL
    (SELECT to_jsonb(current) - ARRAY['lastMovementAt', 'cleanAt', 'pages', 'processedRecords', 'failedPages', 'history'] FROM "DerivedRebuild" current
      EXCEPT ALL SELECT to_jsonb(old) FROM l1_rebuild_preimage old)
  ) THEN RAISE EXCEPTION 'Rebuild cursor preservation failed'; END IF;
END $$;
