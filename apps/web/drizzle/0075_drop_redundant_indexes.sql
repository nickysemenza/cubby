-- cubby:transaction-per-statement
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "McpToolCall_release_idx";
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "UpcLookupCache_fetchedAt_idx";
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "Product_name_active_idx";
--> statement-breakpoint
-- cubby:outside-transaction
DROP INDEX CONCURRENTLY IF EXISTS "Product_brand_active_idx";
