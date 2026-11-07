-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "runAt" timestamp;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "leaseToken" uuid;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "leaseUntil" timestamp;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "leaseStale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN IF NOT EXISTS "waitCause" text;--> statement-breakpoint
-- An evaluation now owes its own work. One transaction holds every source, copies each
-- item's due time, urgency, attempts and wait, and leaves parked evaluations with no due
-- time. An item for a settled evaluation owed nothing and is dropped. A paid
-- `result_ready` row stays pending and is never re-bought. From here an old Worker's
-- mark fails rather than committing intent no consumer reads, and its in-flight page
-- loses its attempt: a provider answer it had not yet stored is bought once more, after
-- that consumer can no longer be running. Deleting a running Job cannot stop its provider
-- call, so its feature's rows stay reserved for longer than a consumer can live.
LOCK TABLE "WorkItem" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "AiEvaluation" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Job" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Job" WHERE kind = 'ai.evaluation' AND state = 'paused') THEN
    RAISE EXCEPTION 'A paused AI evaluation Job has no owner after this cutover; resolve it first';
  END IF;
END $$;
UPDATE "AiEvaluation" e SET
  "runAt" = w."readyAt",
  priority = w.priority,
  attempts = w.attempts,
  "waitCause" = w."waitCause",
  error = coalesce(w."lastError", e.error),
  "leaseToken" = CASE WHEN j.id IS NOT NULL THEN gen_random_uuid() END,
  "leaseUntil" = CASE WHEN j.id IS NOT NULL THEN now() + interval '16 minutes' END
FROM "WorkItem" w
LEFT JOIN "Job" j ON j.key = w.drain AND j.kind = 'ai.evaluation' AND j.state = 'running'
WHERE w.target = 'ai.evaluation' AND w.ref = e.id
  AND e.state IN ('queued', 'result_ready');
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "WorkItem" w JOIN "AiEvaluation" e ON e.id = w.ref
    WHERE w.target = 'ai.evaluation' AND e.state IN ('queued', 'result_ready')
      AND (e."runAt" IS DISTINCT FROM w."readyAt"
        OR e.priority IS DISTINCT FROM w.priority
        OR e.attempts IS DISTINCT FROM w.attempts)
  ) THEN
    RAISE EXCEPTION 'AI evaluation work did not carry over intact';
  END IF;
END $$;
DELETE FROM "WorkItem" WHERE target = 'ai.evaluation';
UPDATE "JobInvalidationCapture" SET observed = true
WHERE key LIKE 'ai-evaluation:%' AND NOT observed;
WITH gone AS (
  DELETE FROM "Job" WHERE kind = 'ai.evaluation' RETURNING id
)
DELETE FROM "Entity" e USING gone WHERE e.id = gone.id AND e.kind = 'job';
ALTER TABLE "WorkItem" DROP CONSTRAINT IF EXISTS "WorkItem_retired_target_check";
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_retired_target_check" CHECK ("WorkItem"."target" NOT IN ('embedding.refresh', 'embedding.cleanup', 'ai.evaluation'));
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_kind_retired_check";
ALTER TABLE "Job" ADD CONSTRAINT "Job_kind_retired_check" CHECK ("Job"."kind" NOT IN ('image.cloud', 'image.device', 'image.device.wake', 'embedding.refresh', 'embedding.cleanup', 'ai.evaluation'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "AiEvaluation_owed_idx" ON "AiEvaluation" USING btree ("feature","priority","runAt") WHERE "AiEvaluation"."runAt" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "AiEvaluation_updatedAt_idx" ON "AiEvaluation" USING btree ("updatedAt");
