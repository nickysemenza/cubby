-- Fence Job writers first: once the trigger exists, a failure an older
-- Worker commits after this migration is converted, and one committed before
-- it is in the backfill below. 0029 locks the same way.
LOCK TABLE "Job" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- Refresh families no longer restart a pass on capture: restarting on every
-- household write kept the search pass from ever finishing. Markers 0028
-- backfilled as restarting follow the new policy.
UPDATE "JobInvalidation" SET "restartsPass" = false
WHERE key LIKE 'refresh:%' AND "restartsPass";--> statement-breakpoint
-- Never-exhausted kinds (NEVER_EXHAUSTED_JOB_KINDS; a guard test keeps this
-- list equal to it) have no terminal failure. A Worker built before this
-- policy can still write failed after the migration commits (a final attempt
-- in flight), so the database turns that write into a backoff: the row stays
-- open work with its attempts and error, and every projection reads it as
-- retrying. Paused and cancelled member stops are untouched.
CREATE FUNCTION job_never_exhausted_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('image.cloud', 'image.device', 'image.device.wake',
    'jobs.retention', 'queue.watchdog', 'refresh.family') THEN
    NEW.state := 'retry_wait';
    NEW."leaseToken" := NULL;
    NEW."leaseExpiresAt" := NULL;
    NEW."availableAt" := greatest(NEW."availableAt", now() + interval '1 minute');
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "Job_never_exhausted_failure" BEFORE INSERT OR UPDATE OF state ON "Job"
  FOR EACH ROW WHEN (NEW.state = 'failed') EXECUTE FUNCTION job_never_exhausted_failure();--> statement-breakpoint
-- Rows these kinds already failed under the old budget retry the same way,
-- keeping their attempts, error, generation and any later availability.
UPDATE "Job" SET state = 'retry_wait', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
  "availableAt" = greatest("availableAt", now()), "updatedAt" = now()
WHERE state = 'failed' AND kind IN ('image.cloud', 'image.device',
  'image.device.wake', 'jobs.retention', 'queue.watchdog', 'refresh.family');
