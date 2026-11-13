-- Inventory admission owns the evidence publication; its model call is an Ask.
INSERT INTO "Pass" (name,key,"runId",cursor,attempts,"maxAttempts","availableAt","waitCause","lastError","cancelledAt","createdAt","updatedAt")
SELECT DISTINCT ON ((j.input->>'locationId')) 'location.inventory', (j.input->>'locationId'), j."runId",
  j.input || jsonb_build_object('generation',j.generation,'page',j.cursor),
  CASE WHEN j.state='failed' THEN greatest(j.attempts,coalesce(j."maxAttempts",5)) ELSE j.attempts END,
  coalesce(j."maxAttempts",5), greatest(j."availableAt",CASE WHEN j.state='running' THEN j."leaseExpiresAt" END),
  CASE WHEN j."waitReason"='ai_funding_window' THEN 'funding' WHEN j."waitReason"='device' THEN 'device' ELSE j."waitReason" END,
  j.error,CASE WHEN j.state IN ('cancelled','paused') THEN j."updatedAt" END,j."createdAt",j."updatedAt"
FROM "Job" j WHERE j.kind='location-ai.inventory.refresh' AND j.state<>'completed'
  AND (j.input->>'locationId') IS NOT NULL
ORDER BY (j.input->>'locationId'),j."updatedAt" DESC
ON CONFLICT (name,key) DO NOTHING;
--> statement-breakpoint
-- Field refresh requests admit the current scope and attribute its Asks to the requesting Run.
WITH requests AS (
  SELECT j.*, CASE WHEN j.kind='location-ai.description.refresh' THEN 'location:' || (j.input->>'locationId')
    ELSE 'run:' || coalesce(j.input->>'runId',j."runId"::text) END AS scope
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
-- The mailbox-link backstop resumes at the durable cursor's next page.
INSERT INTO "Pass" (name,key,cursor,"availableAt","createdAt","updatedAt")
SELECT 'email.purchase-discovery','default',jsonb_build_object('after',metadata->'after'),
  coalesce((metadata->>'nextAt')::timestamptz AT TIME ZONE 'UTC',now()),"updatedAt","updatedAt"
FROM "AppSettings" WHERE id='6c1b7a52-0f1e-4e8a-9f3d-2a4b8d7e5c91'
ON CONFLICT (name,key) DO NOTHING;
--> statement-breakpoint
DELETE FROM "AppSettings" WHERE id='6c1b7a52-0f1e-4e8a-9f3d-2a4b8d7e5c91';
--> statement-breakpoint
DROP TABLE "Job";
