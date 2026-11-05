-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
-- assessment.correction has no handler left, so its terminal rows record nothing. AI refresh
-- activation is now a function of the cron tick. Only finished rows go: an unfinished or
-- paused one stops this migration, including one that arrives after this first check,
-- because the retired-kind check below then refuses it.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Job"
    WHERE kind IN ('assessment.correction', 'ai-refresh.activate')
      AND state NOT IN ('completed', 'failed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Unfinished Jobs of a retired kind remain';
  END IF;
END $$;--> statement-breakpoint
-- cubby:repeat-batch
WITH doomed AS (
  SELECT id FROM "Job"
  WHERE kind IN ('assessment.correction', 'ai-refresh.activate')
    AND state IN ('completed', 'failed', 'cancelled')
  ORDER BY id LIMIT 2000 FOR UPDATE SKIP LOCKED
), gone AS (
  DELETE FROM "Job" j USING doomed d WHERE j.id = d.id RETURNING j.id
)
SELECT (SELECT count(*) FROM gone) = 2000 AS remaining;--> statement-breakpoint
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_kind_retired_check";
ALTER TABLE "Job" ADD CONSTRAINT "Job_kind_retired_check" CHECK ("Job"."kind" NOT IN ('image.cloud', 'image.device', 'image.device.wake', 'embedding.refresh', 'embedding.cleanup', 'ai.evaluation', 'assessment.correction', 'ai-refresh.activate'));