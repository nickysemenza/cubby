-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
ALTER TABLE "EntityEmbedding" ADD COLUMN IF NOT EXISTS "deletionRetryAt" timestamp;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "embeddingDueAt" timestamp;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "embeddingGeneration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "embeddingLeaseToken" uuid;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "embeddingLeaseUntil" timestamp;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "embeddingAttempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "SearchDocument" ADD COLUMN IF NOT EXISTS "embeddingError" text;--> statement-breakpoint
-- The rows now owe this work: a marked document, and an artifact with no deletion
-- receipt, which needs no move at all. One transaction holds every source and refuses
-- the retired work from here on, so an old producer's write fails instead of committing
-- intent no consumer reads. A failed predecessor request is acceptable; a stranded one
-- is not.
LOCK TABLE "WorkItem" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "SearchDocument" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Job" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "Job" WHERE kind IN ('embedding.refresh', 'embedding.cleanup') AND state = 'paused'
  ) THEN
    RAISE EXCEPTION 'A paused embedding Job has no owner after this cutover; resolve it first';
  END IF;
END $$;
-- A running predecessor Job may be paying the provider, and deleting its row cannot
-- stop that call. Its coarse Job held every item, and it dies within the 15 minutes a
-- consumer can run, so reserve them all for as long as a new page's claim would last.
UPDATE "SearchDocument" sd SET
  "embeddingDueAt" = w."readyAt",
  "embeddingAttempts" = w.attempts,
  "embeddingError" = w."lastError",
  "embeddingLeaseToken" = CASE WHEN running.held THEN gen_random_uuid() END,
  "embeddingLeaseUntil" = CASE WHEN running.held THEN now() + interval '16 minutes' END
FROM "WorkItem" w, (
  SELECT EXISTS (SELECT 1 FROM "Job" WHERE kind = 'embedding.refresh' AND state = 'running') AS held
) running
WHERE w.drain = 'embedding:refresh' AND w.target = 'embedding.refresh'
  AND sd."entityId" = w.ref AND sd."deletedAt" IS NULL;
-- An item with no live document owes nothing: its page would have dropped it as missing.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "WorkItem" w
    JOIN "SearchDocument" sd ON sd."entityId" = w.ref AND sd."deletedAt" IS NULL
    WHERE w.target = 'embedding.refresh'
      AND (sd."embeddingDueAt" IS DISTINCT FROM w."readyAt"
        OR sd."embeddingAttempts" IS DISTINCT FROM w.attempts)
  ) THEN
    RAISE EXCEPTION 'Owed embeddings did not carry over intact';
  END IF;
END $$;
DELETE FROM "WorkItem" WHERE target IN ('embedding.refresh', 'embedding.cleanup');
UPDATE "JobInvalidationCapture" SET observed = true
WHERE key IN ('embedding:refresh', 'embedding:cleanup') AND NOT observed;
WITH gone AS (
  DELETE FROM "Job" WHERE kind IN ('embedding.refresh', 'embedding.cleanup') RETURNING id
)
DELETE FROM "Entity" e USING gone WHERE e.id = gone.id AND e.kind = 'job';
ALTER TABLE "WorkItem" DROP CONSTRAINT IF EXISTS "WorkItem_retired_target_check";
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_retired_target_check" CHECK ("WorkItem"."target" NOT IN ('embedding.refresh', 'embedding.cleanup'));
ALTER TABLE "Job" DROP CONSTRAINT IF EXISTS "Job_kind_retired_check";
ALTER TABLE "Job" ADD CONSTRAINT "Job_kind_retired_check" CHECK ("Job"."kind" NOT IN ('image.cloud', 'image.device', 'image.device.wake', 'embedding.refresh', 'embedding.cleanup'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "EntityEmbedding_cleanup_idx" ON "EntityEmbedding" USING btree ("deletionRetryAt") WHERE "EntityEmbedding"."deletionId" IS NULL AND "EntityEmbedding"."artifactState" <> 'selected';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "SearchDocument_embedding_due_idx" ON "SearchDocument" USING btree ("embeddingDueAt") WHERE "SearchDocument"."embeddingDueAt" IS NOT NULL;
