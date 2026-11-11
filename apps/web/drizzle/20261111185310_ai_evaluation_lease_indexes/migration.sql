-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AiEvaluation_live_lease_idx" ON "AiEvaluation" ("leaseUntil","feature") WHERE "leaseUntil" IS NOT NULL;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AiEvaluation_lease_token_idx" ON "AiEvaluation" ("leaseToken") WHERE "leaseToken" IS NOT NULL;
