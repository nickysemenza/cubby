LOCK TABLE "Job", "Pass", "Run", "AppSettings", "AiAnalysis" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Inventory admission owns the evidence publication; its model call is an Ask.
INSERT INTO "Pass" (name,key,"runId",cursor,attempts,"maxAttempts","availableAt","waitCause","lastError","cancelledAt","createdAt","updatedAt")
SELECT DISTINCT ON ((j.input->>'locationId')) 'location.inventory', (j.input->>'locationId'), j."runId",
  j.input || jsonb_build_object('generation',j.generation,'page',j.cursor,'legacyJobs',(SELECT jsonb_agg(to_jsonb(other) ORDER BY other.id) FROM "Job" other WHERE other.kind=j.kind AND other.state<>'completed' AND other.input->>'locationId'=j.input->>'locationId')),
  CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",5)) ELSE j.attempts END,
  coalesce(j."maxAttempts",5), greatest(j."availableAt",CASE WHEN j.state='running' THEN j."leaseExpiresAt" END),
  CASE WHEN j."waitReason"='ai_funding_window' THEN 'funding' WHEN j."waitReason"='device' THEN 'device' ELSE j."waitReason" END,
  j.error,CASE WHEN j.state IN ('cancelled','paused') THEN j."updatedAt" END,j."createdAt",j."updatedAt"
FROM "Job" j WHERE j.kind='location-ai.inventory.refresh' AND j.state<>'completed'
  AND (j.input->>'locationId') IS NOT NULL
ORDER BY (j.input->>'locationId'),(j.state IN ('queued','running','retry_wait')) DESC,j."updatedAt" DESC,j.id
ON CONFLICT (name,key) DO NOTHING;
--> statement-breakpoint
-- Field refresh requests admit the current scope and attribute its Asks to the requesting Run.
WITH requests AS (
  SELECT j.*, CASE WHEN j.kind='location-ai.description.refresh' THEN 'location:' || (j.input->>'locationId')
    ELSE 'run:' || coalesce(j.input->>'subjectRunId',j.input->>'runId',j."runId"::text) END AS scope
  FROM "Job" j WHERE j.kind IN ('location-ai.description.refresh','run-ai.summary.write') AND j.state<>'completed'
)
INSERT INTO "Pass" (name,key,"runId",cursor,attempts,"maxAttempts","availableAt","waitCause","lastError","cancelledAt","createdAt","updatedAt")
SELECT 'fields.reconcile',key,"runId",jsonb_build_object('key',scope,'runId',"runId",'request',input,'generation',generation,'page',cursor),
  CASE WHEN state='failed' THEN greatest(attempts,coalesce("maxAttempts",5)) ELSE attempts END,coalesce("maxAttempts",5),
  greatest("availableAt",CASE WHEN state='running' THEN "leaseExpiresAt" END),
  CASE WHEN "waitReason"='ai_funding_window' THEN 'funding' ELSE "waitReason" END,error,
  CASE WHEN state IN ('cancelled','paused') THEN "updatedAt" END,"createdAt","updatedAt"
FROM requests WHERE scope IS NOT NULL
ON CONFLICT (name,key) DO NOTHING;
--> statement-breakpoint
-- The summary drain can owe a Run end before it has published a Job.
CREATE TEMP TABLE owed_run_summaries ON COMMIT DROP AS
SELECT r.id,r."endedAt" FROM "Run" r
WHERE r."deletedAt" IS NULL AND r."retiredAt" IS NULL AND NOT r.routine AND r.trigger<>'ephemeral'
 AND r."endedAt">='2026-11-12' AND r.status IN ('completed','failed','dispatch_failed','needs_review')
 AND r.purpose NOT IN ('ai_suggest','background','ai_refresh','connection_discovery','derived_refresh','maintenance')
 AND (r.purpose<>'mail_discovery' OR r.status<>'completed')
 AND NOT EXISTS(SELECT 1 FROM "AiAnalysis" a WHERE a."entityKind"='run' AND a."entityId"=r.id AND a.feature='run-summary' AND a."deletedAt" IS NULL AND (a.result->>'generation')::timestamp=date_trunc('milliseconds',r."endedAt"))
 AND NOT EXISTS(SELECT 1 FROM "Job" j WHERE j.key='run-summary:'||r.id||':'||(extract(epoch FROM date_trunc('milliseconds',r."endedAt"))*1000)::bigint::text);
--> statement-breakpoint
INSERT INTO "Pass" (name,key,cursor,"availableAt")
SELECT 'fields.reconcile','run-summary:'||id||':'||(extract(epoch FROM date_trunc('milliseconds',"endedAt"))*1000)::bigint::text,
 jsonb_build_object('key','run:'||id,'runId',NULL,'request',jsonb_build_object('subjectRunId',id,'endedAt',"endedAt")),"endedAt" FROM owed_run_summaries;
--> statement-breakpoint
DO $$ BEGIN
 IF (SELECT count(*) FROM owed_run_summaries)<>(SELECT count(*) FROM owed_run_summaries r JOIN "Pass" p ON p.name='fields.reconcile' AND p.key='run-summary:'||r.id||':'||(extract(epoch FROM date_trunc('milliseconds',r."endedAt"))*1000)::bigint::text AND p.cursor->>'key'='run:'||r.id) THEN RAISE EXCEPTION 'Pending Run summary count preservation mismatch'; END IF;
END $$;
--> statement-breakpoint
-- The mailbox-link backstop resumes at the durable cursor's next page.
INSERT INTO "Pass" (name,key,cursor,"availableAt","createdAt","updatedAt")
SELECT 'email.purchase-discovery','default',jsonb_build_object('after',metadata->'after'),
  coalesce((metadata->>'nextAt')::timestamptz AT TIME ZONE 'UTC',now()),"updatedAt","updatedAt"
FROM "AppSettings" WHERE id='6c1b7a52-0f1e-4e8a-9f3d-2a4b8d7e5c91'
ON CONFLICT (name,key) DO NOTHING;
--> statement-breakpoint
DELETE FROM "AppSettings" WHERE id='6c1b7a52-0f1e-4e8a-9f3d-2a4b8d7e5c91';
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "Job" j WHERE j.state<>'completed' AND j.kind='location-ai.inventory.refresh' AND NOT EXISTS (
 SELECT 1 FROM "Pass" p WHERE p.name='location.inventory' AND p.key=j.input->>'locationId'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.cursor->'legacyJobs') receipt WHERE receipt=to_jsonb(j)))) THEN RAISE EXCEPTION 'Inventory source preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM "Job" j WHERE j.state<>'completed' AND j.kind IN ('location-ai.description.refresh','run-ai.summary.write') AND NOT EXISTS (
 SELECT 1 FROM "Pass" p WHERE p.name='fields.reconcile' AND p.key=j.key AND p.cursor->'request'=j.input
 AND p.cursor->>'key'=CASE WHEN j.kind='location-ai.description.refresh' THEN 'location:'||(j.input->>'locationId') ELSE 'run:'||coalesce(j.input->>'subjectRunId',j.input->>'runId',j."runId"::text) END)) THEN RAISE EXCEPTION 'Field request preservation mismatch'; END IF;
 IF (SELECT count(*) FROM "Job" WHERE state<>'completed' AND kind IN ('location-ai.description.refresh','run-ai.summary.write'))<>(SELECT count(*) FROM "Pass" p JOIN "Job" j ON p.name='fields.reconcile' AND p.key=j.key WHERE j.state<>'completed' AND j.kind IN ('location-ai.description.refresh','run-ai.summary.write')) THEN RAISE EXCEPTION 'Field request count preservation mismatch'; END IF;
 IF (SELECT count(*) FROM "Job" WHERE state<>'completed' AND kind='location-ai.inventory.refresh')<>(SELECT coalesce(sum(jsonb_array_length(p.cursor->'legacyJobs')),0) FROM "Pass" p WHERE p.name='location.inventory') THEN RAISE EXCEPTION 'Inventory source count preservation mismatch'; END IF;
END $$;
--> statement-breakpoint
DROP TABLE "Job";
