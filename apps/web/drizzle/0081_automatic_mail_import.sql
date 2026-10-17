CREATE INDEX "AiUsage_createdAt_idx" ON "AiUsage" USING btree ("createdAt");--> statement-breakpoint
-- Execution approvals are retired. Approval-root Runs and their receipts stay
-- as history; strict Run input schemas refuse the stale reference key.
UPDATE "Run" SET "input" = "input" - 'executionAuthorization'
WHERE jsonb_typeof("input") = 'object' AND "input" ? 'executionAuthorization';--> statement-breakpoint
UPDATE "AiEvaluation"
SET "snapshot" = "snapshot" - 'executionAuthorization' - 'authorizationHistory' - 'minimumBudgetMicroUSD'
WHERE jsonb_typeof("snapshot") = 'object'
  AND ("snapshot" ?| ARRAY['executionAuthorization', 'authorizationHistory', 'minimumBudgetMicroUSD']);--> statement-breakpoint
-- Per-Vendor history passes are replaced by automatic targeted discovery.
-- Close unfinished ones so none resumes or holds the one-active-discovery slot.
UPDATE "Run"
SET "status" = 'completed', "endedAt" = COALESCE("endedAt", now()),
  "failureCode" = 'vendor_history_retired',
  "dispatchError" = 'Vendor history was replaced by automatic Mail import.'
WHERE "purpose" = 'mail_discovery' AND "input" ? 'vendorHistory'
  AND "status" NOT IN ('completed', 'failed', 'dispatch_failed');--> statement-breakpoint
UPDATE "Run" SET "input" = "input" - 'vendorHistory'
WHERE "purpose" = 'mail_discovery' AND "input" ? 'vendorHistory';
