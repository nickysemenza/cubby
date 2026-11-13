-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImageProcessingAttempt_device_started_idx" ON "ImageProcessingAttempt" ("startedAt") WHERE ("executor"->>'kind') = 'device';
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ImageProcessingAttempt_device_completed_idx" ON "ImageProcessingAttempt" ("completedAt") WHERE ("executor"->>'kind') = 'device' AND "state" = 'ready';
