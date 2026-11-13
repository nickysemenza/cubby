LOCK TABLE "Job", "Run", "Pass", "DerivedRebuild" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Run and RunStep retain member intent, discovery pages and step checkpoints.
-- A live legacy lease delays its successor; the kernel never adopts its token.
INSERT INTO "Pass" (name, key, "runId", cursor, attempts, "maxAttempts", "availableAt", "waitCause", "lastError", "cancelledAt", "createdAt", "updatedAt")
SELECT DISTINCT ON (r.id) 'run.execute', r.id::text, r.id,
  jsonb_build_object('runId', r.id::text, 'purpose', r.purpose, 'generation', j.generation, 'page', j.cursor),
  CASE WHEN j.state = 'failed' OR r.status IN ('failed','dispatch_failed') THEN greatest(j.attempts, coalesce(j."maxAttempts", 3)) ELSE j.attempts END,
  coalesce(j."maxAttempts", 3),
  greatest(j."availableAt", CASE WHEN j.state = 'running' THEN j."leaseExpiresAt" END),
  CASE WHEN j."waitReason" = 'ai_funding_window' THEN 'funding'
    WHEN j.state = 'running' AND j."leaseExpiresAt" > now() THEN 'in_flight' ELSE j."waitReason" END,
  j.error, CASE WHEN j.state IN ('paused', 'cancelled') OR r.status IN ('failed','dispatch_failed','completed','needs_review','cancelled', 'paused') AND r."failureCode" IS DISTINCT FROM 'mail_discovery_queued' THEN j."updatedAt" END,
  j."createdAt", j."updatedAt"
FROM "Job" j JOIN "Run" r ON r.id = j."runId"
WHERE j.kind = 'run.execute' AND r.purpose = 'mail_discovery' AND j.state <> 'completed'
ORDER BY r.id,j.generation DESC,(j.state IN ('queued','running','retry_wait')) DESC,j."updatedAt" DESC,j.id
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
-- A Run may be waiting without a live Job after a delivered page or coordinator event.
INSERT INTO "Pass" (name, key, "runId", cursor, "cancelledAt")
SELECT 'run.execute', r.id::text, r.id,
  jsonb_build_object('runId', r.id::text, 'purpose', r.purpose,
    'generation', greatest(coalesce((r.progress->>'attempt')::int, 1), 1)),
  CASE WHEN r.status = 'paused' AND r."failureCode" IS DISTINCT FROM 'mail_discovery_queued' THEN now() END
FROM "Run" r WHERE r.purpose = 'mail_discovery' AND r.status IN ('running', 'paused_auth', 'paused')
  AND r."deletedAt" IS NULL AND r."retiredAt" IS NULL
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
WITH pending AS (
  SELECT r.id, coalesce(jsonb_agg(j.input ORDER BY j."createdAt", j.id) FILTER (WHERE j.input->>'generation'=r."dispatchEventId"::text OR j.input->>'type'<>'start_or_resume'),'[]'::jsonb) AS events,
    max(j.attempts) AS attempts, max(coalesce(j."maxAttempts", 3)) AS max_attempts,
    min(greatest(j."availableAt", CASE WHEN j.state = 'running' THEN j."leaseExpiresAt" END)) AS available_at,
    min(j."createdAt") AS created_at, max(j."updatedAt") AS updated_at,
    (array_agg(j.error ORDER BY j."updatedAt" DESC) FILTER (WHERE j.error IS NOT NULL))[1] AS error,
    bool_and(j.state IN ('paused', 'cancelled')) OR r.status IN ('completed','failed','dispatch_failed','needs_review') AS cancelled,
    bool_and(j.state = 'failed') AS failed
  FROM "Job" j JOIN "Run" r ON r.id = j."runId"
  WHERE j.kind = 'purchase.dispatch' AND j.state <> 'completed'
    AND r.purpose IN ('mail_import', 'photo_inventory')
  GROUP BY r.id
)
INSERT INTO "Pass" (name, key, "runId", cursor, attempts, "maxAttempts", "availableAt", "lastError", "cancelledAt", "createdAt", "updatedAt")
SELECT 'purchase.dispatch', id::text, id, jsonb_build_object('runId', id::text, 'events', events),
  CASE WHEN failed THEN greatest(attempts, max_attempts) ELSE attempts END, max_attempts,
  available_at, error, CASE WHEN cancelled THEN updated_at END, created_at, updated_at FROM pending
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, "runId", cursor)
SELECT 'purchase.dispatch', r.id::text, r.id, jsonb_build_object('runId', r.id::text, 'events',
  CASE WHEN r."coordinatorStartedAt" IS NOT NULL THEN '[]'::jsonb ELSE jsonb_build_array(
    jsonb_build_object('version', 1, 'runId', r.id::text, 'purpose', r.purpose, 'eventId', r."dispatchEventId"::text,
      'generation', r."dispatchEventId"::text, 'type', 'start_or_resume')) END)
FROM "Run" r WHERE r.purpose IN ('mail_import', 'photo_inventory') AND r.status IN ('running', 'paused_auth')
  AND r."dispatchEventId" IS NOT NULL AND r."deletedAt" IS NULL AND r."retiredAt" IS NULL
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
-- Funding uses the frozen deadline, independent of any early wake of its timer Job.
WITH funding AS (
  SELECT r.id, min((j.input->>'until')::timestamp) AS until
  FROM "Job" j JOIN "Run" r ON r.id = j."runId"
  WHERE j.kind = 'run.funding-resume' AND j.state IN ('queued', 'retry_wait', 'running')
    AND r.status = 'paused_auth' AND r."failureCode" = 'execution_limit' AND j.input->>'until' IS NOT NULL
  GROUP BY r.id
)
UPDATE "Pass" p SET "availableAt" = greatest(now() AT TIME ZONE 'UTC', f.until), "waitCause" = 'funding'
FROM funding f WHERE p."runId" = f.id AND p."doneAt" IS NULL AND p."cancelledAt" IS NULL;
--> statement-breakpoint
INSERT INTO "Pass" (name, key, cursor, "availableAt", "doneAt", "lastError", "createdAt", "updatedAt")
SELECT 'derived.snapshot', 'default', jsonb_build_object(
  'target', d.target, 'afterId', d."afterId", 'cursorAttempts', d."cursorAttempts", 'passFailures', d."passFailures",
  'startedAt', to_char(d."startedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'finishedAt', to_char(d."finishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'lastMovementAt', to_char(d."lastMovementAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'cleanAt', to_char(d."cleanAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'failures', d.failures, 'error', d.error, 'durationsMs', to_jsonb(d."durationsMs"),
  'pages', d.pages, 'processedRecords', d."processedRecords", 'failedPages', d."failedPages", 'history', d.history),
  CASE WHEN d.running THEN greatest(now() AT TIME ZONE 'UTC', d."leaseExpiresAt") ELSE now() AT TIME ZONE 'UTC' END,
  CASE WHEN NOT d.running THEN coalesce(d."finishedAt", now() AT TIME ZONE 'UTC') END,
  d.error, d."createdAt", coalesce(d."lastMovementAt", d."createdAt")
FROM "DerivedRebuild" d
ON CONFLICT (name, key) DO NOTHING;
--> statement-breakpoint
UPDATE "Pass" p SET cursor=coalesce(p.cursor,'{}'::jsonb)||jsonb_build_object('legacyJobs',
 (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM "Job" j WHERE j."runId"=p."runId" AND j.kind=p.name AND j.state<>'completed'))
WHERE p.name IN ('run.execute','purchase.dispatch') AND EXISTS(SELECT 1 FROM "Job" j WHERE j."runId"=p."runId" AND j.kind=p.name AND j.state<>'completed');
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Job" j WHERE j.kind IN ('run.execute','purchase.dispatch') AND j.state<>'completed' AND NOT EXISTS(
 SELECT 1 FROM "Pass" p WHERE p.name=j.kind AND p."runId"=j."runId" AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.cursor->'legacyJobs') r WHERE r=to_jsonb(j)))) THEN RAISE EXCEPTION 'Execution source preservation mismatch'; END IF;
 IF (SELECT count(*) FROM "Job" WHERE kind IN ('run.execute','purchase.dispatch') AND state<>'completed')<>(SELECT coalesce(sum(jsonb_array_length(cursor->'legacyJobs')),0) FROM "Pass" WHERE name IN ('run.execute','purchase.dispatch') AND "runId" IN (SELECT "runId" FROM "Job" WHERE kind IN ('run.execute','purchase.dispatch') AND state<>'completed')) THEN RAISE EXCEPTION 'Execution source count preservation mismatch'; END IF;
END $$;
--> statement-breakpoint
DELETE FROM "Job" WHERE kind IN ('run.execute', 'purchase.dispatch', 'run.funding-resume', 'maintenance.purchase-discovery', 'calendar-feed.mark-dirty');
--> statement-breakpoint
DROP TABLE "DerivedRebuild";
