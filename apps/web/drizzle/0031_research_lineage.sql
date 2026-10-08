ALTER TABLE "Run" ADD COLUMN "cause" text;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "parentRunId" uuid;--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_parentRunId_Run_id_fk" FOREIGN KEY ("parentRunId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Run_parent_started_idx" ON "Run" USING btree ("parentRunId","startedAt");--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_cause_check" CHECK ("Run"."cause" IN ('member_request', 'scheduled', 'source_discovered', 'import_completed', 'evidence_changed', 'retry'));--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_attempt_positive" CHECK ("Run"."attempt" IS NULL OR "Run"."attempt" > 0);