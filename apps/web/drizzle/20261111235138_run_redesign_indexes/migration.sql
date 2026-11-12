-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Run_ended_summary_idx" ON "Run" ("endedAt" DESC NULLS LAST) WHERE "endedAt" IS NOT NULL AND "trigger" <> 'ephemeral' AND "purpose" NOT IN ('ai_suggest', 'background');
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Run_predecessorRunId_idx" ON "Run" ("predecessorRunId");
--> statement-breakpoint
ALTER TABLE "AiAnalysis" DROP CONSTRAINT IF EXISTS "AiAnalysis_entityKind_check", ADD CONSTRAINT "AiAnalysis_entityKind_check" CHECK ("entityKind" IN ('image', 'location', 'product', 'recipe', 'run', 'global'));
--> statement-breakpoint
UPDATE "Run" SET "cause" = 'member_request' WHERE "purpose" = 'photo_inventory' AND "cause" IS NULL;
