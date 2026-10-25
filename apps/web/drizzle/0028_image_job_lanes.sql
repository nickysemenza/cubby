ALTER TABLE "ImageProcessingAttempt" DROP CONSTRAINT "ImageProcessingAttempt_state_check";--> statement-breakpoint
CREATE INDEX "Job_kind_state_idx" ON "Job" USING btree ("kind","state","availableAt");--> statement-breakpoint
ALTER TABLE "ImageProcessingAttempt" ADD CONSTRAINT "ImageProcessingAttempt_state_check" CHECK ("ImageProcessingAttempt"."state" IN ('leased','running','waiting','expired','released','ready','skipped','failed'));--> statement-breakpoint
-- The universal Job now owns image execution state; the row keeps only its
-- outcome. Open work is `pending` (leased and device-waiting rows included),
-- and image work never ends as failed: every failure with a live source
-- reopens. Superseded processors are retired as skipped by the queue
-- watchdog using the code's revision constants.
UPDATE "ImageProcessingJob" SET state = 'pending', "completedAt" = NULL
WHERE state IN ('leased', 'waiting_for_device');--> statement-breakpoint
UPDATE "ImageProcessingJob" j SET state = 'pending', "completedAt" = NULL
FROM "Image" i
WHERE i.id = j."imageId" AND j.state = 'failed' AND i."deletedAt" IS NULL
  AND i.status = 'UPLOADED' AND i.sha256 = j."sourceContentHash";--> statement-breakpoint
-- Executor lanes: Apple devices run subject lifts, Apple descriptions
-- (processor revision 1985616673, IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION)
-- and the JPEG preparation an AVIF cloud description needs; the server runs
-- every other cloud call. Mirrors `imageProcessingLane`.
UPDATE "Job" dj SET kind = CASE
    WHEN j.kind = 'subject_lift'
      OR (j.kind = 'describe_image' AND (j."processorRevision" = 1985616673 OR i."contentType" = 'image/avif'))
    THEN 'image.device' ELSE 'image.cloud' END,
  "updatedAt" = now()
FROM "ImageProcessingJob" j
JOIN "Image" i ON i.id = j."imageId"
WHERE dj.key = 'image-processing:' || j.id::text AND dj.kind = 'image.processing';--> statement-breakpoint
UPDATE "Job" SET kind = 'image.cloud', "updatedAt" = now() WHERE kind = 'image.processing';--> statement-breakpoint
-- Requeue every stopped execution of open work: exhausted (`failed`) Jobs
-- stranded their rows as leased, and none may stay abandoned.
UPDATE "Job" dj SET state = 'queued', attempts = 0, generation = dj.generation + 1,
  "availableAt" = now(), "waitReason" = NULL, "waitUntil" = NULL,
  "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
FROM "ImageProcessingJob" j
WHERE dj.key = 'image-processing:' || j.id::text AND j.state = 'pending'
  AND dj.state IN ('failed', 'cancelled', 'completed', 'paused');--> statement-breakpoint
INSERT INTO "Job" (key, kind, input, "subjectKind", "subjectId", "runId", "availableAt")
SELECT 'image-processing:' || j.id::text,
  CASE
    WHEN j.kind = 'subject_lift'
      OR (j.kind = 'describe_image' AND (j."processorRevision" = 1985616673 OR i."contentType" = 'image/avif'))
    THEN 'image.device' ELSE 'image.cloud' END,
  jsonb_build_object('processingId', j.id::text), 'image', j."imageId"::text, j."runId", now()
FROM "ImageProcessingJob" j
JOIN "Image" i ON i.id = j."imageId"
WHERE j.state = 'pending'
  AND NOT EXISTS (SELECT 1 FROM "Job" dj WHERE dj.key = 'image-processing:' || j.id::text);
