-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "DerivedValue_computed_idx" ON "DerivedValue" USING btree ("computedAt");--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Job_kind_position_idx" ON "Job" USING btree ("kind",(-"priority"),"updatedAt","availableAt","id");