CREATE TABLE "ResearchRetention" (
	"id" uuid PRIMARY KEY NOT NULL,
	"runId" uuid NOT NULL,
	"workRef" uuid NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"orderMailId" uuid NOT NULL,
	"mailboxId" text NOT NULL,
	"messageId" text NOT NULL,
	"checksum" text NOT NULL,
	"phase" text NOT NULL,
	"plan" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	CONSTRAINT "ResearchRetention_phase_check" CHECK ("ResearchRetention"."phase" IN ('fenced', 'objects_deleted', 'coordinators_destroyed', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "ResearchSourceExposure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"orderMailId" uuid NOT NULL,
	"checksum" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "retiredAt" timestamp;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "retirementReason" text;--> statement-breakpoint
ALTER TABLE "ResearchRetention" ADD CONSTRAINT "ResearchRetention_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResearchRetention" ADD CONSTRAINT "ResearchRetention_workRef_RunTarget_id_fk" FOREIGN KEY ("workRef") REFERENCES "public"."RunTarget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResearchRetention" ADD CONSTRAINT "ResearchRetention_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResearchSourceExposure" ADD CONSTRAINT "ResearchSourceExposure_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ResearchSourceExposure" ADD CONSTRAINT "ResearchSourceExposure_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ResearchRetention_source_checksum_key" ON "ResearchRetention" USING btree ("ledgerPartyId","orderMailId","checksum");--> statement-breakpoint
CREATE INDEX "ResearchRetention_phase_idx" ON "ResearchRetention" USING btree ("phase");--> statement-breakpoint
CREATE UNIQUE INDEX "ResearchSourceExposure_run_source_key" ON "ResearchSourceExposure" USING btree ("runId","orderMailId","checksum");--> statement-breakpoint
CREATE INDEX "ResearchSourceExposure_source_idx" ON "ResearchSourceExposure" USING btree ("ledgerPartyId","orderMailId","checksum");