ALTER TABLE "FinancialAccount" ADD COLUMN "primaryCardholderId" uuid;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD COLUMN "authorizedUsers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD COLUMN "fundingPeriods" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "purchaserOverrideId" uuid;--> statement-breakpoint
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_primaryCardholderId_LedgerParty_id_fk" FOREIGN KEY ("primaryCardholderId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_purchaserOverrideId_LedgerParty_id_fk" FOREIGN KEY ("purchaserOverrideId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "FinancialAccount_primaryCardholderId_idx" ON "FinancialAccount" USING btree ("primaryCardholderId");--> statement-breakpoint
CREATE INDEX "Purchase_purchaserOverrideId_idx" ON "Purchase" USING btree ("purchaserOverrideId");