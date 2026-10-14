-- Frozen inputs, per-Email receipts and observation history remain unchanged.
UPDATE "Run"
SET "purpose" = 'mail_reclassify'
WHERE "purpose" = 'background'
  AND "input"->>'kind' = 'mail_reclassify'
  AND "input"->>'mode' = 'relevance'
  AND ("status" IN ('completed', 'failed')
    OR ("status" = 'needs_review' AND "failureCode" = 'execution_limit'));
--> statement-breakpoint
-- Honor persisted member pauses before any new driver can claim the legacy roster.
UPDATE "Run"
SET "status" = 'paused'
WHERE "purpose" = 'suggestion_sweep'
  AND "status" = 'running'
  AND "input"->>'paused' = 'true';
