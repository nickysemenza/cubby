ALTER TABLE "SourceOrderObservation" ADD COLUMN "ledgerPartyId" uuid;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD COLUMN "emailId" uuid;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD COLUMN "sourceKind" text DEFAULT 'browser_order' NOT NULL;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD COLUMN "sourceExternalKey" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD COLUMN "answerHash" text;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ALTER COLUMN "sourceClaimId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ALTER COLUMN "purchaseId" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "SourceOrderObservation_source_content_key" ON "SourceOrderObservation" ("ledgerPartyId","sourceKind","sourceExternalKey","orderKey","checksum","contentFingerprint") WHERE "purchaseId" IS NULL;--> statement-breakpoint
CREATE INDEX "SourceOrderObservation_order_key_idx" ON "SourceOrderObservation" ("orderKey");--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "LedgerParty"("id");--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES "Email"("id");
--> statement-breakpoint
UPDATE "SourceOrderObservation" o SET "ledgerPartyId" = c."ledgerPartyId", "sourceKind" = c.kind, "sourceExternalKey" = c."externalKey"
FROM "ImportSourceClaim" c WHERE c.id = o."sourceClaimId";
--> statement-breakpoint
UPDATE "SourceOrderObservation" o SET "emailId" = e.id
FROM "Email" e WHERE e."ledgerPartyId" = o."ledgerPartyId" AND o."sourceKind" IN ('mail_message', 'mail_attachment')
AND o."sourceExternalKey" = 'gmail:' || e."mailboxId" || ':' || e."messageId";
