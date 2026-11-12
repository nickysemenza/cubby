-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Suggestion_member_decision_idx" ON "Suggestion" ("entity","recordId") WHERE "status" = 'superseded' AND "decisions" <> '[]'::jsonb;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Vendor_orderEmailSenders_gin_idx" ON "Vendor" USING gin ("orderEmailSenders") WHERE "deletedAt" IS NULL;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Vendor_orderEmailSenderPolicies_gin_idx" ON "Vendor" USING gin ("orderEmailSenderPolicies") WHERE "deletedAt" IS NULL;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "EntityEmbedding_deletion_exhausted_idx" ON "EntityEmbedding" ("updatedAt") WHERE "deletionId" IS NULL AND "deletionAttempts" >= 5;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SearchDocument_embedding_exhausted_idx" ON "SearchDocument" ("updatedAt") WHERE "embeddingAttempts" >= 5 AND "deletedAt" IS NULL;
