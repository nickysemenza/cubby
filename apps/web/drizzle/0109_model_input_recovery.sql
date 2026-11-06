-- Retain analysis requests and their evidence while current code heals them.
-- Member pauses/cancellations and live execution leases remain untouched.
UPDATE "Job"
SET "maxAttempts" = NULL,
    state = CASE WHEN state = 'failed' THEN 'retry_wait' ELSE state END,
    generation = generation + CASE WHEN state = 'failed' THEN 1 ELSE 0 END,
    "updatedAt" = now()
WHERE kind IN ('location-ai.description.refresh', 'location-ai.inventory.refresh');
--> statement-breakpoint
-- Legacy failed outer Email gates predate the typed durable-retry signal.
-- Preserve cursor, result, attempts, input and original error; resume, don't restart.
UPDATE "Job"
SET state = 'retry_wait',
    generation = generation + 1,
    "maxAttempts" = CASE WHEN "maxAttempts" IS NULL THEN NULL
      ELSE GREATEST("maxAttempts", attempts + 1) END,
    "updatedAt" = now()
WHERE state = 'failed'
  AND error LIKE '%AssessmentCorrectionLock%'
  AND error LIKE '%email-evidence-write%'
  AND error ~ '"code"[[:space:]]*:[[:space:]]*"40001"';
