ALTER TABLE "McpToolCall" ADD COLUMN "runId" uuid;--> statement-breakpoint
ALTER TABLE "McpToolCall" ADD CONSTRAINT "McpToolCall_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "McpToolCall_runId_idx" ON "McpToolCall" USING btree ("runId") WHERE "McpToolCall"."runId" IS NOT NULL;