-- Retain analysis requests and their evidence while current code heals them.
-- Member pauses/cancellations and live execution leases remain untouched.
UPDATE "Job"
SET "maxAttempts" = NULL,
    state = CASE WHEN state = 'failed' THEN 'retry_wait' ELSE state END,
    generation = generation + CASE WHEN state = 'failed' THEN 1 ELSE 0 END,
    "availableAt" = CASE WHEN state = 'failed' THEN GREATEST("availableAt",
      now() + ((hashtext(id::text)::bigint + 2147483648) % 900) * interval '1 second') ELSE "availableAt" END,
    "updatedAt" = now()
WHERE kind IN ('location-ai.description.refresh', 'location-ai.inventory.refresh');
--> statement-breakpoint
-- Legacy failed outer Email gates predate the typed durable-retry signal.
-- Preserve cursor, result, attempts, input and original error; resume, don't restart.
WITH recoverable AS MATERIALIZED (
  SELECT j.id, j."runId", j.kind
  FROM "Job" j
  WHERE j.state = 'failed'
    AND j.error LIKE '%AssessmentCorrectionLock%'
    AND j.error LIKE '%email-evidence-write%'
    AND j.error ~ '"code"[[:space:]]*:[[:space:]]*"40001"'
    AND (j.kind <> 'run.execute' OR j."runId" IS NULL OR EXISTS (
      SELECT 1 FROM "Run" r WHERE r.id = j."runId"
        AND r."deletedAt" IS NULL AND r."retiredAt" IS NULL
        AND (r.status = 'running' OR (r.status = 'failed' AND r."failureCode" = 'job_failed'))
        AND NOT EXISTS (SELECT 1 FROM "Run" next WHERE next."predecessorRunId" = r.id AND next."deletedAt" IS NULL)
    ))
)
UPDATE "Job" j
SET state = 'retry_wait',
    generation = j.generation + 1,
    "maxAttempts" = CASE WHEN j."maxAttempts" IS NULL THEN NULL
      ELSE GREATEST(j."maxAttempts", j.attempts + 1) END,
    "updatedAt" = now()
FROM recoverable c
WHERE j.id = c.id AND j.state = 'failed';
