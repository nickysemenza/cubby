CREATE TABLE "ConnectionCandidateEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"scopeKey" text NOT NULL,
	"fingerprint" text NOT NULL CONSTRAINT "ConnectionCandidateEvidence_fingerprint_key" UNIQUE,
	"sourceEntity" text NOT NULL,
	"sourceId" uuid NOT NULL,
	"targetEntity" text NOT NULL,
	"targetId" uuid NOT NULL,
	"candidate" jsonb NOT NULL,
	"basis" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "MailHandlingReceipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"runId" uuid NOT NULL,
	"emailId" uuid NOT NULL,
	"key" text NOT NULL CONSTRAINT "MailHandlingReceipt_key_key" UNIQUE,
	"receipt" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PhotoInventoryEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"locationId" uuid NOT NULL,
	"runId" uuid,
	"fingerprint" text NOT NULL CONSTRAINT "PhotoInventoryEvidence_fingerprint_key" UNIQUE,
	"sourceSnapshot" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AskScope" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "AskScope" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "AskScope" ADD COLUMN "cancelledAt" timestamp;--> statement-breakpoint
CREATE INDEX "ConnectionCandidateEvidence_scope_idx" ON "ConnectionCandidateEvidence" ("scopeKey");--> statement-breakpoint
ALTER TABLE "MailHandlingReceipt" ADD CONSTRAINT "MailHandlingReceipt_runId_Run_id_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id");--> statement-breakpoint
ALTER TABLE "MailHandlingReceipt" ADD CONSTRAINT "MailHandlingReceipt_emailId_Email_id_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id");--> statement-breakpoint
ALTER TABLE "PhotoInventoryEvidence" ADD CONSTRAINT "PhotoInventoryEvidence_locationId_Location_id_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id");--> statement-breakpoint
ALTER TABLE "PhotoInventoryEvidence" ADD CONSTRAINT "PhotoInventoryEvidence_runId_Run_id_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id");