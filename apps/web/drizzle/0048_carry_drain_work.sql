-- Carry AiEvaluation execution states into the drain model: retry and lease
-- state now live on the drain's WorkItem, so retry_wait and running become
-- queued. Only running rows can collide with the open-slot index (it already
-- covered queued and retry_wait); the newest open row of a slot stays queued.
UPDATE "AiEvaluation" SET state = 'queued' WHERE state = 'retry_wait';--> statement-breakpoint
WITH ranked AS (
  SELECT e.id, row_number() OVER (PARTITION BY e."slotKey" ORDER BY e."createdAt" DESC, e.id DESC) AS position
    FROM "AiEvaluation" e
   WHERE e.state = 'running'
     AND NOT EXISTS (SELECT 1 FROM "AiEvaluation" o WHERE o."slotKey" = e."slotKey" AND o.state = 'queued')
)
UPDATE "AiEvaluation" e SET state = CASE WHEN ranked.position = 1 THEN 'queued' ELSE 'obsolete' END
  FROM ranked WHERE ranked.id = e.id;--> statement-breakpoint
UPDATE "AiEvaluation" SET state = 'obsolete' WHERE state = 'running';--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP CONSTRAINT "AiEvaluation_state_check";--> statement-breakpoint
DROP INDEX "AiEvaluation_open_slot_key";--> statement-breakpoint
DROP INDEX "AiEvaluation_pending_share_key";--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluation_open_slot_key" ON "AiEvaluation" USING btree ("slotKey") WHERE "AiEvaluation"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "AiEvaluation_pending_share_key" ON "AiEvaluation" USING btree ("shareKey") WHERE "AiEvaluation"."shareKey" IS NOT NULL AND "AiEvaluation"."state" IN ('queued','result_ready');--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD CONSTRAINT "AiEvaluation_state_check" CHECK ("AiEvaluation"."state" IN ('queued','result_ready','completed','blocked','failed','obsolete','cancelled'));
--> statement-breakpoint
-- Open evaluations become work items of their feature's drain, keeping the
-- old per-evaluation Job's attempts, backoff and raw error. Live Run demand
-- (the owning Run or an uncancelled request from a running Run) ranks first.
INSERT INTO "WorkItem" (drain, target, ref, priority, "dirtiedAt", "readyAt", attempts, "lastError")
SELECT 'ai-evaluation:' || e.feature, 'ai.evaluation', e.id,
       CASE WHEN EXISTS (
         SELECT 1 FROM "Run" r WHERE r.status = 'running' AND (
           r.id = e."runId" OR r.id IN (
             SELECT q."runId" FROM "AiEvaluationRequest" q
              WHERE q."evaluationId" = e.id AND q."cancelledAt" IS NULL))
       ) THEN 0 ELSE 1 END,
       e."createdAt",
       coalesce(greatest(j."availableAt", j."waitUntil"), now()),
       CASE WHEN j.state IN ('queued', 'retry_wait', 'running') THEN j.attempts ELSE 0 END,
       j.error
  FROM "AiEvaluation" e
  LEFT JOIN "Job" j ON j.key = 'ai-evaluation:' || e.id
 WHERE e.state IN ('queued', 'result_ready')
ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
DELETE FROM "JobInvalidationCapture" c USING "Job" j
 WHERE c.key = j.key AND j.kind = 'ai.evaluation';--> statement-breakpoint
CREATE TEMP TABLE "retired_job_ids" ON COMMIT DROP AS
SELECT id FROM "Job" WHERE kind = 'ai.evaluation';--> statement-breakpoint
DELETE FROM "Job" WHERE id IN (SELECT id FROM "retired_job_ids");--> statement-breakpoint
DELETE FROM "Entity" WHERE kind = 'job' AND id IN (SELECT id FROM "retired_job_ids");--> statement-breakpoint
DROP TABLE "retired_job_ids";--> statement-breakpoint
-- Embeddings: a per-source Job id was the physical vector id. Any refresh Job
-- without an artifact row may own a Vectorize vector (an interrupted, retired
-- or orphaned upload), so it becomes a retired artifact under that id and
-- cleanup deletes it; deleting an absent vector is harmless. A source with an
-- open refresh is re-embedded under a fresh artifact: vectors are rebuildable
-- projections (ADR 0006), so in-flight receipts are not carried.
UPDATE "EntityEmbedding" SET "artifactState" = 'retired', "deletedAt" = coalesce("deletedAt", now())
 WHERE "artifactState" = 'legacy';--> statement-breakpoint
INSERT INTO "EntityEmbedding" (id, "entityKind", "entityId", "embeddingText", "embeddingHash", provider, model, dimensions, "artifactState", "artifactHash", "deletedAt")
SELECT j.id, j.input->>'entityKind', (j.input->>'entityId')::uuid, j.input->>'text', j.input->>'hash',
       j.input->'config'->>'provider', j.input->'config'->>'model', (j.input->'config'->>'dimensions')::int,
       'retired', j.input->>'hash', now()
  FROM "Job" j
  JOIN "Entity" source ON source.id = (j.input->>'entityId')::uuid AND source.kind = j.input->>'entityKind'
 WHERE j.kind = 'embedding.refresh'
   AND j.input->'config' ? 'dimensions'
   AND NOT EXISTS (SELECT 1 FROM "EntityEmbedding" e WHERE e.id = j.id);--> statement-breakpoint
INSERT INTO "WorkItem" (drain, target, ref, priority, "dirtiedAt", "readyAt", attempts, "lastError")
SELECT DISTINCT ON ((j.input->>'entityId')::uuid)
       'embedding:refresh', 'embedding.refresh', (j.input->>'entityId')::uuid, 1, j."createdAt", now(), 0, j.error
  FROM "Job" j
  JOIN "Entity" source ON source.id = (j.input->>'entityId')::uuid AND source.kind = j.input->>'entityKind'
 WHERE j.kind = 'embedding.refresh' AND j.state IN ('queued', 'retry_wait', 'running', 'paused')
 ORDER BY (j.input->>'entityId')::uuid, j."createdAt" DESC
ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
INSERT INTO "WorkItem" (drain, target, ref, priority, "dirtiedAt", "readyAt")
SELECT 'embedding:cleanup', 'embedding.cleanup', e.id, 1, now(), now()
  FROM "EntityEmbedding" e
 WHERE (e."deletedAt" IS NOT NULL OR e."artifactState" IN ('retired', 'failed')) AND e."deletionId" IS NULL
ON CONFLICT (target, ref) DO NOTHING;--> statement-breakpoint
DELETE FROM "JobInvalidationCapture" c USING "Job" j
 WHERE c.key = j.key AND j.kind IN ('embedding.refresh', 'embedding.cleanup');--> statement-breakpoint
CREATE TEMP TABLE "retired_embedding_job_ids" ON COMMIT DROP AS
SELECT id FROM "Job" WHERE kind IN ('embedding.refresh', 'embedding.cleanup');--> statement-breakpoint
DELETE FROM "Job" WHERE id IN (SELECT id FROM "retired_embedding_job_ids");--> statement-breakpoint
DELETE FROM "Entity" WHERE kind = 'job' AND id IN (SELECT id FROM "retired_embedding_job_ids");--> statement-breakpoint
DROP TABLE "retired_embedding_job_ids";--> statement-breakpoint
-- The watchdog and retention merge into jobs.maintenance, which the minute
-- cron creates; their old Jobs and identities go.
DELETE FROM "JobInvalidationCapture" c USING "Job" j
 WHERE c.key = j.key AND j.kind IN ('queue.watchdog', 'jobs.retention');--> statement-breakpoint
CREATE TEMP TABLE "retired_maintenance_job_ids" ON COMMIT DROP AS
SELECT id FROM "Job" WHERE kind IN ('queue.watchdog', 'jobs.retention');--> statement-breakpoint
DELETE FROM "Job" WHERE id IN (SELECT id FROM "retired_maintenance_job_ids");--> statement-breakpoint
DELETE FROM "Entity" WHERE kind = 'job' AND id IN (SELECT id FROM "retired_maintenance_job_ids");--> statement-breakpoint
DROP TABLE "retired_maintenance_job_ids";--> statement-breakpoint
-- One drain Job (with its identity) per drain that owes work, woken once.
WITH drains AS (
  SELECT DISTINCT w.drain AS key,
         CASE WHEN w.drain LIKE 'ai-evaluation:%' THEN 'ai.evaluation'
              WHEN w.drain = 'embedding:refresh' THEN 'embedding.refresh'
              WHEN w.drain = 'embedding:cleanup' THEN 'embedding.cleanup'
              WHEN w.drain = 'derived:drain' THEN 'derived.drain' END AS kind
    FROM "WorkItem" w
   WHERE NOT EXISTS (SELECT 1 FROM "Job" j WHERE j.key = w.drain)
), identities AS (
  SELECT gen_random_uuid() AS id, key, kind,
    'JOB-' || (SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',
      1 + (('x' || substr(md5(key || gen_random_uuid()::text), 1 + 2 * letter, 2))::bit(8)::int % length('23456789ABCDEFGHJKMNPQRSTUVWXYZ')), 1), '')
      FROM generate_series(0, 9) letter) AS shortcode
    FROM drains WHERE kind IS NOT NULL
), entities AS (
  INSERT INTO "Entity" (id, kind, shortcode) SELECT id, 'job', shortcode FROM identities RETURNING id
), captures AS (
  INSERT INTO "JobInvalidationCapture" (key, "capturedAt") SELECT key, now() FROM identities
)
INSERT INTO "Job" (id, shortcode, key, kind, input, "maxAttempts")
SELECT i.id, i.shortcode, i.key, i.kind, '{}'::jsonb, NULL FROM identities i JOIN entities USING (id);
