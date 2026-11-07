-- Keep eligibility, member controls and slot admission stable through this repair.
-- The normal migration runner holds these locks through its transaction commit.
LOCK TABLE "Run", "AiEvaluationRequest", "AiEvaluation", "ImageProcessingJob"
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Terminal evaluations cannot owe execution. Retain every result and receipt.
UPDATE "AiEvaluation"
SET "runAt" = NULL, "leaseToken" = NULL, "leaseUntil" = NULL,
    "leaseStale" = false, "waitCause" = NULL
WHERE state IN ('completed', 'obsolete') AND "runAt" IS NOT NULL
  AND ("leaseUntil" IS NULL OR "leaseUntil" <= now());
--> statement-breakpoint
-- A device's deterministic refusal remains inspectable until an explicit retry.
UPDATE "ImageProcessingJob"
SET state = 'failed', "completedAt" = COALESCE("completedAt", "updatedAt"),
    "leaseUntil" = NULL, "waitReason" = NULL
WHERE state = 'pending'
  AND ((result->>'status' = 'failed' AND result->>'retryable' = 'false')
    OR result->>'reason' = 'unsupported_format')
  AND ("leaseUntil" IS NULL OR "leaseUntil" <= now());
--> statement-breakpoint
-- These refusals prove an old candidate obsolete, rather than a broken writer.
UPDATE "AiEvaluation"
SET state = 'obsolete', "runAt" = NULL, "leaseToken" = NULL,
    "leaseUntil" = NULL, "leaseStale" = false, "waitCause" = NULL
WHERE state = 'failed' AND feature = 'entity-connections'
  AND (error LIKE '%Connection Product/Purchase pair is no longer eligible because acquisition is already recorded%'
    OR error LIKE '%Connection Expense is no longer eligible for acquisition or is already assigned to a Product%')
  AND ("leaseUntil" IS NULL OR "leaseUntil" <= now());
--> statement-breakpoint
-- Restore only the newest unchanged funding failure in an otherwise idle slot.
-- Member stops and historical terminal owners require their ordinary Run controls.
WITH eligible AS MATERIALIZED (
  SELECT DISTINCT ON (e."slotKey") e.id
  FROM "AiEvaluation" e
  WHERE e.state = 'failed' AND e.error LIKE '%402%' AND e.error LIKE '%TypeSafe%'
    AND (e."leaseUntil" IS NULL OR e."leaseUntil" <= now())
    AND (e."runId" IS NULL OR EXISTS (
      SELECT 1 FROM "Run" r WHERE r.id = e."runId"
        AND r.status = 'running'
        AND r."deletedAt" IS NULL AND r."retiredAt" IS NULL
    ))
    AND NOT EXISTS (SELECT 1 FROM "AiEvaluation" newer
      WHERE newer."slotKey" = e."slotKey" AND newer.state IN ('queued', 'result_ready'))
    AND NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" request
      WHERE request."evaluationId" = e.id AND request."cancelledAt" IS NOT NULL)
  ORDER BY e."slotKey", e."createdAt" DESC, e.id DESC
)
UPDATE "AiEvaluation" e
SET state = CASE WHEN e.result IS NULL THEN 'queued' ELSE 'result_ready' END,
    attempts = 0, "runAt" = GREATEST(COALESCE(e."runAt", now()), now() + interval '15 minutes'),
    "leaseToken" = NULL, "leaseUntil" = NULL, "leaseStale" = false,
    "waitCause" = 'provider_capacity'
FROM eligible WHERE e.id = eligible.id;
