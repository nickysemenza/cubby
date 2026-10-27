ALTER TABLE "Job" ADD COLUMN "admissionToken" uuid;
--> statement-breakpoint
-- Restore the owning demand for roster evaluations enrolled before requests were recorded.
INSERT INTO "AiEvaluationRequest" ("runId", "evaluationId", "cancelledAt", receipt)
SELECT e."runId", e.id,
  CASE WHEN r."failureCode" = 'user_cancelled'
    AND e.state IN ('queued', 'running', 'result_ready', 'retry_wait', 'blocked', 'cancelled')
    AND e.receipt IS NULL THEN r."updatedAt" ELSE NULL END,
  e.receipt
FROM "AiEvaluation" e JOIN "Run" r ON r.id = e."runId"
ON CONFLICT ("runId", "evaluationId") DO NOTHING;
