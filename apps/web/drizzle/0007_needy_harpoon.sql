-- Authorized non-graceful cutover. Lock sources and durable destinations before copying.
LOCK TABLE "Run", "Job", "AuditLog" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "subjectKind" text;--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "subjectId" text;--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "waitReason" text;--> statement-breakpoint
ALTER TABLE "Job" ADD COLUMN "waitUntil" timestamp;--> statement-breakpoint
CREATE INDEX "Job_subject_idx" ON "Job" USING btree ("subjectKind","subjectId");--> statement-breakpoint
INSERT INTO "AuditLog" ("entityId", "entityKind", action, changes, "userId", channel, "runId")
SELECT id, 'run', 'update', jsonb_build_object('dispatchAttempts', jsonb_build_object('from', "dispatchAttempts", 'to', NULL)), "actorUserId", 'system', id
FROM "Run";
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Run" r WHERE NOT EXISTS (
    SELECT 1 FROM "AuditLog" a WHERE a."entityId"=r.id AND a."entityKind"='run'
      AND a.changes->'dispatchAttempts'->>'from'=r."dispatchAttempts"::text
  )) THEN RAISE EXCEPTION 'Dispatch accounting has no verified history destination'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "Run" DROP COLUMN "dispatchAttempts";--> statement-breakpoint
ALTER TABLE "Job" ADD CONSTRAINT "Job_waitReason_check" CHECK ("Job"."waitReason" IN ('provider_capacity','ai_funding_window','device','rate_limit'));--> statement-breakpoint
ALTER TABLE "Job" ADD CONSTRAINT "Job_subject_check" CHECK (("Job"."subjectKind" IS NULL) = ("Job"."subjectId" IS NULL));
--> statement-breakpoint
-- Retained unacknowledged handoffs acquire durable Job intent before transport retirement.
INSERT INTO "Job" (key, kind, "runId", state, attempts, error, input)
SELECT 'purchase-dispatch:' || id || ':start_or_resume:' || "dispatchEventId", 'purchase.dispatch', id,
  CASE WHEN status='dispatch_failed' THEN 'failed' ELSE 'queued' END,
  CASE WHEN status='dispatch_failed' THEN 3 ELSE 0 END,
  "dispatchError",
  jsonb_build_object('version', 1, 'runId', id, 'purpose', purpose, 'type', 'start_or_resume', 'eventId', "dispatchEventId", 'generation', "dispatchEventId")
FROM "Run" WHERE purpose IN ('mail_import','photo_inventory') AND status IN ('running','dispatch_failed')
  AND "coordinatorStartedAt" IS NULL AND "dispatchEventId" IS NOT NULL AND "retiredAt" IS NULL AND "deletedAt" IS NULL
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Existing funding pauses must not depend on alarms removed by this deployment.
WITH paused AS (
  SELECT id, greatest(now() AT TIME ZONE 'UTC',
    date_bin(interval '6 hours', "updatedAt", timestamp '1970-01-01') + interval '6 hours 1 minute') AS resume_at
  FROM "Run" WHERE status='paused_auth' AND "failureCode"='execution_limit' AND "deletedAt" IS NULL AND "retiredAt" IS NULL
)
INSERT INTO "Job" (key, kind, "runId", input, "waitReason", "waitUntil", "availableAt")
SELECT 'funding-resume:' || id || ':cutover', 'run.funding-resume', id,
  jsonb_build_object('runId', id, 'until', to_char(resume_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'ai_funding_window', resume_at, resume_at
FROM paused ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Subject references preserve diagnostics for already admitted single-item work.
UPDATE "Job" SET "subjectKind"=input->>'entityKind', "subjectId"=input->>'entityId'
WHERE kind='embedding.refresh' AND input->>'entityKind' IS NOT NULL AND input->>'entityId' IS NOT NULL;
--> statement-breakpoint
UPDATE "Job" j SET "subjectKind"='image', "subjectId"=p."imageId"::text FROM "ImageProcessingJob" p
WHERE j.kind='image.processing' AND j.input->>'processingId'=p.id::text;
--> statement-breakpoint
UPDATE "Job" SET "subjectKind"='image', "subjectId"=input->>'imageId'
WHERE kind='image-metadata.extract' AND input->>'imageId' IS NOT NULL;
--> statement-breakpoint
UPDATE "Job" SET "subjectKind"='location', "subjectId"=input->>'locationId'
WHERE kind IN ('location-ai.description.refresh','location-ai.inventory.refresh') AND input->>'locationId' IS NOT NULL;
--> statement-breakpoint
UPDATE "Job" SET "subjectKind"='calendar', "subjectId"=input->>'origin'
WHERE kind='calendar-feed.mark-dirty' AND input->>'origin' IS NOT NULL;
--> statement-breakpoint
UPDATE "Job" cleanup SET "subjectKind"=source."subjectKind", "subjectId"=source."subjectId" FROM "Job" source
WHERE cleanup.kind='embedding.cleanup' AND cleanup.input->>'artifactId'=source.id::text;

--> statement-breakpoint
UPDATE "Job" cleanup SET "subjectKind"=e."entityKind", "subjectId"=e."entityId"::text FROM "EntityEmbedding" e
WHERE cleanup.kind='embedding.cleanup' AND cleanup."subjectId" IS NULL AND cleanup.input->>'artifactId'=e.id::text;
