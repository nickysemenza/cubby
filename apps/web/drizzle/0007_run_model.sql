ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
DROP INDEX "Run_one_active_derived_refresh";--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'suggestion_sweep', 'ai_refresh', 'background', 'file_import', 'mail_search', 'mail_discovery', 'mail_reclassify', 'connection_discovery', 'maintenance', 'derived_refresh', 'sweep'));--> statement-breakpoint
-- R1: Sweeps no longer fan out child Runs. Child ai_refresh / suggestion_sweep
-- Runs still open under a Sweep end here, releasing the AI refresh capacity
-- paused orphans held (#2873); their pending evaluations and Jobs stop.
CREATE TEMP TABLE "_released_sweep_child" ON COMMIT DROP AS
  SELECT child.id FROM "Run" child
  JOIN "Run" parent ON parent.id = child."parentRunId"
  WHERE parent.purpose = 'sweep'
    AND child.purpose IN ('ai_refresh', 'suggestion_sweep')
    AND child.status IN ('running', 'paused', 'paused_auth', 'paused_offline');--> statement-breakpoint
-- R15: step-ledger Runs restart under the new step registry. Open ones end as
-- superseded with their RunStep counts retained; no old cursor is adapted.
CREATE TEMP TABLE "_superseded_run" ON COMMIT DROP AS
  SELECT id FROM "Run"
  WHERE purpose IN ('sweep', 'maintenance', 'derived_refresh')
    AND status IN ('running', 'paused', 'paused_auth', 'paused_offline')
  UNION
  SELECT id FROM "_released_sweep_child";--> statement-breakpoint
UPDATE "AiEvaluationRequest" SET "cancelledAt" = now()
  WHERE "runId" IN (SELECT id FROM "_superseded_run")
    AND "cancelledAt" IS NULL AND receipt IS NULL;--> statement-breakpoint
UPDATE "AiEvaluation" e SET state = 'cancelled', error = 'Superseded by deployment', "updatedAt" = now()
  WHERE e.state IN ('queued', 'running', 'result_ready', 'retry_wait')
    AND (
      e."runId" IN (SELECT id FROM "_superseded_run")
      OR (
        EXISTS (SELECT 1 FROM "AiEvaluationRequest" own WHERE own."evaluationId" = e.id AND own."runId" IN (SELECT id FROM "_superseded_run"))
        AND NOT EXISTS (
          SELECT 1 FROM "AiEvaluationRequest" demand JOIN "Run" requester ON requester.id = demand."runId"
          WHERE demand."evaluationId" = e.id AND demand."cancelledAt" IS NULL
            AND requester.id NOT IN (SELECT id FROM "_superseded_run")
            AND requester.status IN ('running', 'paused', 'paused_auth') AND requester."deletedAt" IS NULL
        )
      )
    );--> statement-breakpoint
UPDATE "Job" SET state = 'cancelled', generation = generation + 1, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
    error = 'Superseded by deployment', "updatedAt" = now()
  WHERE state IN ('queued', 'running', 'retry_wait', 'paused')
    AND (
      "runId" IN (SELECT id FROM "_superseded_run")
      OR key IN (SELECT 'ai-evaluation:' || e.id::text FROM "AiEvaluation" e WHERE e.state = 'cancelled' AND e.error = 'Superseded by deployment')
    );--> statement-breakpoint
UPDATE "RunStep" SET state = 'paused', "pausedReason" = 'Superseded by deployment', "pausedUntil" = NULL
  WHERE "runId" IN (SELECT id FROM "_superseded_run")
    AND state IN ('queued', 'running', 'waiting', 'paused');--> statement-breakpoint
UPDATE "Run" SET status = 'failed', "endedAt" = now(), "failureCode" = 'superseded_by_deployment',
    "dispatchError" = 'Superseded by deployment'
  WHERE id IN (SELECT id FROM "_superseded_run");
