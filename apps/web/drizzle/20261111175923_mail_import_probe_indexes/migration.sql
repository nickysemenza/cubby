-- cubby:transaction-per-statement
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Run_party_evidenceRevision_idx" ON "Run" ("ledgerPartyId",("input"->>'evidenceRevision')) WHERE ("input"->>'evidenceRevision') IS NOT NULL;
--> statement-breakpoint
-- cubby:outside-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "RunOperation_claim_email_message_idx" ON "RunOperation" (("result" #>> '{email,messageId}')) WHERE "kind" = 'claim_next_work' AND "state" = 'completed';
