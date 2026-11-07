DROP INDEX "AiEvaluation_open_slot_key";--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluation_open_slot_key" ON "AiEvaluation" ("slotKey","executionKind") WHERE "state" = 'queued';