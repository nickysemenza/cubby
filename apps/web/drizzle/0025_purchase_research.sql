CREATE TABLE "ImportSourceOrder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceClaimId" uuid NOT NULL,
	"orderKey" text NOT NULL,
	"purchaseId" uuid NOT NULL,
	"checksum" text NOT NULL,
	"outputFingerprint" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "MailboxMessage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledgerPartyId" uuid NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"mailboxId" text NOT NULL,
	"messageId" text NOT NULL,
	"checksum" text NOT NULL,
	"classification" text NOT NULL,
	"classificationVersion" text NOT NULL,
	"status" text NOT NULL,
	"orderMailId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "MailboxMessage_classification_check" CHECK ("MailboxMessage"."classification" IN ('related', 'unrelated', 'uncertain')),
	CONSTRAINT "MailboxMessage_status_check" CHECK ("MailboxMessage"."status" IN ('pending', 'researching', 'completed', 'blocked', 'deleted', 'excluded'))
);
--> statement-breakpoint
CREATE TABLE "RunFactEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"targetId" uuid NOT NULL,
	"evidenceId" uuid NOT NULL,
	"fieldPath" text NOT NULL,
	"value" jsonb NOT NULL,
	"valueFingerprint" text NOT NULL,
	"support" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "RunEvidence" DROP CONSTRAINT "RunEvidence_kind_check";--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" DROP CONSTRAINT "ImportSourceClaim_purchaseId_Purchase_id_fk";
--> statement-breakpoint
DROP INDEX "ImportSourceClaim_purchase_idx";--> statement-breakpoint
DROP INDEX "MailboxCursor_party_provider_key";--> statement-breakpoint
DROP INDEX "OrderMail_party_message_key";--> statement-breakpoint
ALTER TABLE "Purchase" ALTER COLUMN "date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "MailboxCursor" ADD COLUMN "mailboxId" text;--> statement-breakpoint
ALTER TABLE "MailboxCursor" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "OrderMail" ADD COLUMN "mailboxId" text;--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD CONSTRAINT "ImportSourceOrder_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES "public"."ImportSourceClaim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD CONSTRAINT "ImportSourceOrder_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES "public"."OrderMail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_targetId_RunTarget_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."RunTarget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_evidenceId_RunEvidence_id_fk" FOREIGN KEY ("evidenceId") REFERENCES "public"."RunEvidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ImportSourceOrder_source_order_key" ON "ImportSourceOrder" USING btree ("sourceClaimId","orderKey");--> statement-breakpoint
CREATE INDEX "ImportSourceOrder_purchase_idx" ON "ImportSourceOrder" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "MailboxMessage_mailbox_message_key" ON "MailboxMessage" USING btree ("ledgerPartyId","provider","mailboxId","messageId");--> statement-breakpoint
CREATE INDEX "MailboxMessage_pending_idx" ON "MailboxMessage" USING btree ("ledgerPartyId","mailboxId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "RunFactEvidence_claim_key" ON "RunFactEvidence" USING btree ("targetId","evidenceId","fieldPath","valueFingerprint");--> statement-breakpoint
-- Preserve source associations and their replay keys before dropping the singular shape.
INSERT INTO "ImportSourceOrder" ("id", "sourceClaimId", "orderKey", "purchaseId", "checksum", "outputFingerprint", "createdAt", "updatedAt")
SELECT c."id", c."id",
  p."vendorId"::text || CASE WHEN p."orderId" IS NOT NULL THEN '/order/' || p."orderId" ELSE '/receipt/whole' END,
  c."purchaseId", c."checksum", c."outputFingerprint", c."createdAt", c."updatedAt"
FROM "ImportSourceClaim" c JOIN "Purchase" p ON p."id" = c."purchaseId";
--> statement-breakpoint
-- Current Google connections do not establish historical mailbox ownership.
-- Preserve originals and coverage under an explicit unknown legacy scope;
-- only a separately verified mapping may associate them with a Google subject.
UPDATE "MailboxCursor" c SET "mailboxId" = 'legacy:' || c."ledgerPartyId"::text;
--> statement-breakpoint
UPDATE "OrderMail" m SET "mailboxId" = 'legacy:' || m."ledgerPartyId"::text;
--> statement-breakpoint
ALTER TABLE "MailboxCursor" ALTER COLUMN "mailboxId" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "OrderMail" ALTER COLUMN "mailboxId" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "MailboxCursor_party_provider_mailbox_key" ON "MailboxCursor" USING btree ("ledgerPartyId","provider","mailboxId");--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMail_mailbox_message_key" ON "OrderMail" USING btree ("ledgerPartyId","mailboxId","messageId");--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" DROP COLUMN "purchaseId";--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" DROP COLUMN "outputFingerprint";--> statement-breakpoint
ALTER TABLE "RunEvidence" ADD CONSTRAINT "RunEvidence_kind_check" CHECK ("RunEvidence"."kind" IN ('browser_capture', 'web_page', 'mail_message', 'gmail_attachment', 'manual_upload'));
