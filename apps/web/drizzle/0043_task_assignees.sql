ALTER TABLE "Project" ADD COLUMN "assigneeId" uuid;--> statement-breakpoint
ALTER TABLE "Project" ADD COLUMN "assigneeMode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "Task" ADD COLUMN "assigneeId" uuid;--> statement-breakpoint
ALTER TABLE "Task" ADD COLUMN "assigneeMode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "Project" ADD CONSTRAINT "Project_assigneeId_LedgerParty_id_fk" FOREIGN KEY ("assigneeId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_LedgerParty_id_fk" FOREIGN KEY ("assigneeId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Project_assigneeId_idx" ON "Project" USING btree ("assigneeId");--> statement-breakpoint
CREATE INDEX "Task_assigneeId_idx" ON "Task" USING btree ("assigneeId");