-- Refresh families no longer restart a pass on capture: restarting on every
-- household write kept the search pass from ever finishing. Markers 0028
-- backfilled as restarting follow the new policy.
UPDATE "JobInvalidation" SET "restartsPass" = false
WHERE key LIKE 'refresh:%' AND "restartsPass";--> statement-breakpoint
-- Families are now never exhausted; a pass that failed under the old budget
-- starts over instead of waiting for an explicit retry.
UPDATE "Job" SET
  state = 'queued',
  generation = generation + 1,
  cursor = NULL,
  attempts = 0,
  "leaseToken" = NULL,
  "leaseExpiresAt" = NULL,
  "availableAt" = now(),
  "updatedAt" = now()
WHERE kind = 'refresh.family' AND state = 'failed';
