CREATE TABLE "MailHandlingReceipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"runId" uuid NOT NULL,
	"emailId" uuid NOT NULL,
	"key" text NOT NULL CONSTRAINT "MailHandlingReceipt_key_key" UNIQUE,
	"receipt" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AskScope" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "AskScope" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "AskScope" ADD COLUMN "cancelledAt" timestamp;--> statement-breakpoint
ALTER TABLE "MailHandlingReceipt" ADD CONSTRAINT "MailHandlingReceipt_runId_Run_id_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id");--> statement-breakpoint
ALTER TABLE "MailHandlingReceipt" ADD CONSTRAINT "MailHandlingReceipt_emailId_Email_id_fkey" FOREIGN KEY ("emailId") REFERENCES "Email"("id");