ALTER TABLE "Job" ADD COLUMN "leaseHolder" jsonb;--> statement-breakpoint
-- Leases held before this column: the image attempt the lease token names.
UPDATE "Job" j SET "leaseHolder" = jsonb_build_object(
    'name', a.executor->>'name', 'deviceId', a.executor->>'deviceId')
  FROM "ImageProcessingAttempt" a
 WHERE a.id = j."leaseToken" AND j.state = 'running'
   AND j.key LIKE 'image-processing:%';
