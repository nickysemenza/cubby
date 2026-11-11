-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SourceTransactionRecord_amount_date_idx" ON "SourceTransactionRecord" ("providerAmountMinor","statementDate");
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "AiEvaluation_pending_share_key";
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "Suggestion_statement_refs_idx";
