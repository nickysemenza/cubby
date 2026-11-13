-- cubby:transaction-per-statement
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "provenance" jsonb;
--> statement-breakpoint
ALTER TABLE "RecordKey" ADD COLUMN IF NOT EXISTS "mergedAt" timestamp;
--> statement-breakpoint
ALTER TABLE "ScopeState" ADD COLUMN IF NOT EXISTS "mergedIntoKey" text;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_kernel_createdAt_idx" ON "AuditLog" ("createdAt" DESC NULLS LAST) WHERE "provenance" IS NOT NULL;
