CREATE INDEX "Ask_queued_idx" ON "Ask" ("availableAt","createdAt") WHERE "state" = 'queued' AND NOT "hosted" AND "executor" IS NULL AND "cancelledAt" IS NULL;--> statement-breakpoint
CREATE INDEX "Ask_held_idx" ON "Ask" ("claimPartition") WHERE "claimToken" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ScopeDirty_held_idx" ON "ScopeDirty" ("claimDeadline") WHERE "claimToken" IS NOT NULL;