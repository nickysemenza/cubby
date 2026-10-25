/**
 * Never-exhausted Job kinds have no terminal failure: a `failed` write of
 * one (an older build's final attempt) is stored as a backoff, keeping its
 * attempts and error. The kind list must equal `NEVER_EXHAUSTED_JOB_KINDS`;
 * the queue-watchdog integration test checks the installed function.
 */
export const jobNeverExhaustedDdl = () => `
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
END $$;
CREATE TRIGGER "Job_never_exhausted_failure" BEFORE INSERT OR UPDATE OF state ON "Job"
  FOR EACH ROW WHEN (NEW.state = 'failed') EXECUTE FUNCTION job_never_exhausted_failure();
`;
