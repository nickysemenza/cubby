CREATE TABLE "EmailFinancialAssociation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emailId" uuid NOT NULL,
	"evidenceChecksum" text NOT NULL,
	"transactionId" uuid NOT NULL,
	"reviewedAccountId" uuid NOT NULL,
	"sourceAccountLabel" text NOT NULL,
	"reviewReason" text NOT NULL,
	"decidedByUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailFinancialAssociation_evidenceChecksum_check" CHECK (length(btrim("EmailFinancialAssociation"."evidenceChecksum")) > 0),
	CONSTRAINT "EmailFinancialAssociation_sourceAccountLabel_check" CHECK (length(btrim("EmailFinancialAssociation"."sourceAccountLabel")) > 0),
	CONSTRAINT "EmailFinancialAssociation_reviewReason_check" CHECK (length(btrim("EmailFinancialAssociation"."reviewReason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "EmailFinancialAssociation" ADD CONSTRAINT "EmailFinancialAssociation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."Email"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailFinancialAssociation" ADD CONSTRAINT "EmailFinancialAssociation_transactionId_FinancialTransaction_id_fk" FOREIGN KEY ("transactionId") REFERENCES "public"."FinancialTransaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailFinancialAssociation" ADD CONSTRAINT "EmailFinancialAssociation_reviewedAccountId_FinancialAccount_id_fk" FOREIGN KEY ("reviewedAccountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailFinancialAssociation" ADD CONSTRAINT "EmailFinancialAssociation_decidedByUserId_user_id_fk" FOREIGN KEY ("decidedByUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "EmailFinancialAssociation_email_evidence_transaction_key" ON "EmailFinancialAssociation" USING btree ("emailId","evidenceChecksum","transactionId");--> statement-breakpoint
CREATE INDEX "EmailFinancialAssociation_transaction_idx" ON "EmailFinancialAssociation" USING btree ("transactionId");