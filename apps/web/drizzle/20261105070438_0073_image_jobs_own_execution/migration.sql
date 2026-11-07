-- cubby:transaction-per-statement
-- ImageProcessingJob becomes the sole owner of image execution. Live writers cross
-- ImageProcessingJob and Job in both orders, so no one lock order is safe: every
-- statement here is idempotent and runs alone under a 2-second lock timeout, and the
-- runner retries it whole on a lock timeout or deadlock. The added columns are inert
-- for the running Worker. A failure leaves it working, and the next Deploy resumes.
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "lane" text;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "runAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "leaseUntil" timestamp;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN IF NOT EXISTS "waitReason" text;--> statement-breakpoint
-- The cutover is one transaction, so copy and retirement cannot part. It holds both
-- tables whole: an in-flight lease or backoff write lands before the copy or not at
-- all. The old Worker's image writes fail from here until the matching deploy, on
-- `lane` and on the retired-kind check below. That is an accepted non-graceful
-- cutover, and a refused scheduling is recreated by the image backfill.
LOCK TABLE "ImageProcessingJob" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "Job" IN ACCESS EXCLUSIVE MODE;
-- A paused execution of open image work has no owner after this. None exists at
-- this writing; if one appeared, stop rather than resume a member's pause.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "ImageProcessingJob" p
    JOIN "Job" dj ON dj.key = 'image-processing:' || p.id::text
    WHERE p.state = 'pending' AND dj.state = 'paused'
  ) THEN
    RAISE EXCEPTION 'A paused image Job has open work; resolve it before this cutover';
  END IF;
END $$;
-- Mirrors imageProcessingLane. 1985616673 is IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION.
UPDATE "ImageProcessingJob" p SET lane = CASE
    WHEN p.kind = 'subject_lift'
      OR (p.kind = 'describe_image' AND (p."processorRevision" = 1985616673 OR i."contentType" = 'image/avif'))
    THEN 'device' ELSE 'cloud' END
FROM "Image" i
WHERE i.id = p."imageId" AND p.lane IS NULL;
ALTER TABLE "ImageProcessingJob" ALTER COLUMN "lane" SET NOT NULL;
-- Carry each open execution: backoff, failure count, wait and a held lease. An
-- attempt keeps its id, so a device working now can still renew and complete.
UPDATE "ImageProcessingJob" p SET
  "runAt" = dj."availableAt",
  failures = dj.attempts,
  "waitReason" = dj."waitReason",
  "leaseUntil" = CASE WHEN dj.state = 'running' THEN dj."leaseExpiresAt" END,
  "attemptId" = CASE WHEN dj.state = 'running' THEN dj."leaseToken" ELSE p."attemptId" END
FROM "Job" dj
WHERE dj.key = 'image-processing:' || p.id::text
  AND p.state = 'pending'
  AND dj.state IN ('queued', 'retry_wait', 'running');
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "ImageProcessingJob" p
    JOIN "Job" dj ON dj.key = 'image-processing:' || p.id::text
    WHERE p.state = 'pending' AND dj.state IN ('queued', 'retry_wait', 'running')
      AND (p."runAt" IS DISTINCT FROM dj."availableAt"
        OR p.failures IS DISTINCT FROM dj.attempts
        OR p."waitReason" IS DISTINCT FROM dj."waitReason"
        OR (dj.state = 'running' AND (p."leaseUntil" IS DISTINCT FROM dj."leaseExpiresAt"
          OR p."attemptId" IS DISTINCT FROM dj."leaseToken"))
        OR p.lane <> CASE WHEN dj.kind = 'image.device' THEN 'device' ELSE 'cloud' END)
  ) THEN
    RAISE EXCEPTION 'Image execution did not carry over intact';
  END IF;
END $$;
-- The rows above now own this work, so the open executions end here.
UPDATE "Job" SET
  state = 'completed',
  generation = generation + 1,
  result = jsonb_build_object('outcome', 'moved to ImageProcessingJob'),
  "waitReason" = NULL,
  "waitUntil" = NULL,
  "leaseToken" = NULL,
  "leaseExpiresAt" = NULL,
  "leaseHolder" = NULL,
  "updatedAt" = now()
WHERE kind IN ('image.cloud', 'image.device', 'image.device.wake')
  AND state IN ('queued', 'retry_wait', 'running');
UPDATE "JobInvalidationCapture" SET observed = true
WHERE key = 'image.device.wake' AND NOT observed;--> statement-breakpoint
-- Terminal image Jobs are execution receipts: each attempt, result and error lives on
-- ImageProcessingAttempt and its image row, and retention would prune them anyway.
-- Pruned in batches so no statement holds locks across the whole set.
-- cubby:repeat-batch
WITH doomed AS (
  SELECT id FROM "Job"
  WHERE kind IN ('image.cloud', 'image.device', 'image.device.wake') AND state IN ('completed', 'cancelled', 'failed')
  ORDER BY id LIMIT 2000 FOR UPDATE SKIP LOCKED
), gone AS (
  DELETE FROM "Job" j USING doomed d WHERE j.id = d.id RETURNING j.id
), identities AS (
  DELETE FROM "Entity" e USING gone WHERE e.id = gone.id AND e.kind = 'job' RETURNING e.id
)
SELECT (SELECT count(*) FROM identities) = 2000 AS remaining;--> statement-breakpoint
-- From here a retired kind cannot be written at all, so a late predecessor write fails
-- rather than committing work nothing serves. Anything it wrote since the cutover goes
-- first: its image row already owns that work.
LOCK TABLE "Job" IN ACCESS EXCLUSIVE MODE;
WITH gone AS (
  DELETE FROM "Job" WHERE kind IN ('image.cloud', 'image.device', 'image.device.wake') RETURNING id
)
DELETE FROM "Entity" e USING gone WHERE e.id = gone.id AND e.kind = 'job';
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_kind_retired_check";
ALTER TABLE "Job" ADD CONSTRAINT "Job_kind_retired_check" CHECK ("Job"."kind" NOT IN ('image.cloud', 'image.device', 'image.device.wake'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ImageProcessingJob_open_idx" ON "ImageProcessingJob" USING btree ("lane","runAt") WHERE "ImageProcessingJob"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT IF EXISTS "ImageProcessingJob_lane_check";
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_lane_check" CHECK ("ImageProcessingJob"."lane" IN ('cloud', 'device'));--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT IF EXISTS "ImageProcessingJob_waitReason_check";
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_waitReason_check" CHECK ("ImageProcessingJob"."waitReason" IN ('provider_capacity', 'ai_funding_window', 'device', 'rate_limit'));--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT IF EXISTS "ImageProcessingJob_failures_check";
ALTER TABLE "ImageProcessingJob" ADD CONSTRAINT "ImageProcessingJob_failures_check" CHECK ("ImageProcessingJob"."failures" >= 0);
