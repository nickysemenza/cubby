-- Apply with Cubby writers quiesced. This is additive and intentionally does
-- not backfill ownership: link each LedgerParty.userId and create
-- VendorAccounts after deploy, then start imports.
BEGIN;

ALTER TABLE "LedgerParty" ADD COLUMN "userId" text REFERENCES "user"("id");
CREATE UNIQUE INDEX "LedgerParty_member_user_key" ON "LedgerParty" ("userId")
  WHERE "deletedAt" IS NULL AND "userId" IS NOT NULL;
ALTER TABLE "LedgerParty" ADD CONSTRAINT "LedgerParty_user_member_check"
  CHECK ("userId" IS NULL OR "kind" = 'member');

ALTER TABLE "Vendor"
  ADD COLUMN "orderEvidence" text,
  ADD COLUMN "orderEmailSenders" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "browserDomains" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN "agentHints" jsonb NOT NULL DEFAULT '{"ordersListUrl":null,"pagination":null,"orderLinkPattern":null,"notes":[]}',
  ADD COLUMN "returnWindowDays" integer;
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orderEvidence_check"
  CHECK ("orderEvidence" IS NULL OR "orderEvidence" IN ('online_account', 'receipt_only', 'not_expected'));
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_returnWindowDays_check"
  CHECK ("returnWindowDays" IS NULL OR "returnWindowDays" >= 0);

CREATE TABLE "VendorAccount" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shortcode" text NOT NULL,
  "label" text NOT NULL,
  "vendorId" uuid NOT NULL REFERENCES "Vendor"("id"),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "browser" text NOT NULL DEFAULT 'chrome',
  "cursor" jsonb NOT NULL DEFAULT '{"newestOrderAt":null,"orderIdsOnNewestDate":[],"backfillBeforeOrderAt":null,"earliestAvailableOrderAt":null}',
  "lastRunAt" timestamp,
  "lastSuccessAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "deletedAt" timestamp,
  CONSTRAINT "VendorAccount_status_check" CHECK ("status" IN ('active', 'paused_auth', 'paused_offline', 'disabled')),
  CONSTRAINT "VendorAccount_browser_check" CHECK ("browser" IN ('chrome', 'safari'))
);
CREATE UNIQUE INDEX "VendorAccount_shortcode_key" ON "VendorAccount" ("shortcode");
CREATE UNIQUE INDEX "VendorAccount_vendor_member_key" ON "VendorAccount" ("vendorId", "ledgerPartyId") WHERE "deletedAt" IS NULL;
CREATE INDEX "VendorAccount_vendorId_idx" ON "VendorAccount" ("vendorId");
CREATE INDEX "VendorAccount_ledgerPartyId_idx" ON "VendorAccount" ("ledgerPartyId");

ALTER TABLE "Purchase" ADD COLUMN "vendorAccountId" uuid REFERENCES "VendorAccount"("id");
CREATE INDEX "Purchase_vendorAccountId_idx" ON "Purchase" ("vendorAccountId");

CREATE TABLE "ImportRun" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "vendorAccountId" uuid REFERENCES "VendorAccount"("id"),
  "trigger" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "startedAt" timestamp NOT NULL DEFAULT now(),
  "endedAt" timestamp,
  "ordersSeen" integer NOT NULL DEFAULT 0,
  "imported" integer NOT NULL DEFAULT 0,
  "updated" integer NOT NULL DEFAULT 0,
  "skipped" integer NOT NULL DEFAULT 0,
  "failureCode" text,
  "agentSessionId" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ImportRun_trigger_check" CHECK ("trigger" IN ('foreground', 'discovery', 'manual', 'backfill')),
  CONSTRAINT "ImportRun_status_check" CHECK ("status" IN ('running', 'paused_auth', 'paused_offline', 'completed', 'failed'))
);
CREATE INDEX "ImportRun_party_started_idx" ON "ImportRun" ("ledgerPartyId", "startedAt" DESC);
CREATE INDEX "ImportRun_vendorAccount_started_idx" ON "ImportRun" ("vendorAccountId", "startedAt" DESC);

ALTER TABLE "Purchase" ADD COLUMN "importRunId" uuid REFERENCES "ImportRun"("id");
CREATE INDEX "Purchase_importRunId_idx" ON "Purchase" ("importRunId");

CREATE TABLE "ImportSourceClaim" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "vendorAccountId" uuid REFERENCES "VendorAccount"("id"),
  "kind" text NOT NULL,
  "externalKey" text NOT NULL,
  "checksum" text NOT NULL,
  "purchaseId" uuid REFERENCES "Purchase"("id"),
  "firstRunId" uuid NOT NULL REFERENCES "ImportRun"("id"),
  "lastRunId" uuid NOT NULL REFERENCES "ImportRun"("id"),
  "outputFingerprint" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ImportSourceClaim_kind_check" CHECK ("kind" IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export'))
);
CREATE UNIQUE INDEX "ImportSourceClaim_source_key" ON "ImportSourceClaim" ("ledgerPartyId", "kind", "externalKey");
CREATE INDEX "ImportSourceClaim_purchase_idx" ON "ImportSourceClaim" ("purchaseId");

CREATE TABLE "ImportRunMutation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "runId" uuid NOT NULL REFERENCES "ImportRun"("id"),
  "targetType" text NOT NULL,
  "targetId" uuid NOT NULL,
  "mutationKind" text NOT NULL,
  "fields" jsonb NOT NULL DEFAULT '[]',
  "postFingerprint" text NOT NULL,
  "auditLogId" uuid,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "ImportRunMutation_run_idx" ON "ImportRunMutation" ("runId");
CREATE INDEX "ImportRunMutation_target_idx" ON "ImportRunMutation" ("targetType", "targetId");

CREATE TABLE "ImportFinding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "importRunId" uuid REFERENCES "ImportRun"("id"),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "targetType" text NOT NULL,
  "targetId" uuid NOT NULL,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "proposedFix" jsonb,
  "evidenceFingerprint" text NOT NULL,
  "autoApplied" boolean NOT NULL DEFAULT false,
  "probability" real,
  "status" text NOT NULL DEFAULT 'open',
  "resolvedAt" timestamp,
  "resolvedByUserId" text REFERENCES "user"("id"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ImportFinding_status_check" CHECK ("status" IN ('open', 'applied', 'dismissed')),
  CONSTRAINT "ImportFinding_target_check" CHECK ("targetType" IN ('purchase', 'expense', 'product'))
);
CREATE UNIQUE INDEX "ImportFinding_open_evidence_key" ON "ImportFinding" ("ledgerPartyId", "targetType", "targetId", "kind", "evidenceFingerprint") WHERE "status" = 'open';
CREATE INDEX "ImportFinding_status_idx" ON "ImportFinding" ("status", "createdAt" DESC);

CREATE TABLE "ImportHunt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "financialTransactionId" uuid NOT NULL REFERENCES "FinancialTransaction"("id"),
  "vendorId" uuid REFERENCES "Vendor"("id"),
  "vendorAccountId" uuid REFERENCES "VendorAccount"("id"),
  "state" text NOT NULL DEFAULT 'pending_mail',
  "dateFrom" date NOT NULL,
  "dateTo" date NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "matchedOrderIds" jsonb NOT NULL DEFAULT '[]',
  "error" text,
  "receiptImageId" uuid REFERENCES "Image"("id"),
  "receiptQueuedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "ImportHunt_transaction_key" ON "ImportHunt" ("financialTransactionId");
CREATE INDEX "ImportHunt_worklist_idx" ON "ImportHunt" ("state", "updatedAt");
CREATE UNIQUE INDEX "ImportHunt_receipt_image_key" ON "ImportHunt" ("id", "receiptImageId") WHERE "receiptImageId" IS NOT NULL;

CREATE TABLE "MerchantVendorRule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "normalizedMerchant" text NOT NULL,
  "vendorId" uuid NOT NULL REFERENCES "Vendor"("id"),
  "confirmedByUserId" text NOT NULL REFERENCES "user"("id"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "MerchantVendorRule_party_merchant_key" ON "MerchantVendorRule" ("ledgerPartyId", "normalizedMerchant");

CREATE TABLE "MailboxCursor" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "provider" text NOT NULL DEFAULT 'gmail',
  "historyId" text,
  "lastPolledAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "MailboxCursor_party_provider_key" ON "MailboxCursor" ("ledgerPartyId", "provider");

CREATE TABLE "OrderMail" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "vendorId" uuid REFERENCES "Vendor"("id"),
  "messageId" text NOT NULL,
  "threadId" text,
  "historyId" text,
  "sender" text NOT NULL,
  "subject" text NOT NULL,
  "receivedAt" timestamp NOT NULL,
  "rawChecksum" text NOT NULL,
  "content" jsonb NOT NULL DEFAULT '{"snippet":null,"bodyText":null,"bodyHtml":null}',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "OrderMail_party_message_key" ON "OrderMail" ("ledgerPartyId", "messageId");
CREATE INDEX "OrderMail_party_received_idx" ON "OrderMail" ("ledgerPartyId", "receivedAt" DESC);

CREATE TABLE "OrderMailEvent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderMailId" uuid NOT NULL REFERENCES "OrderMail"("id"),
  "event" text NOT NULL,
  "orderId" text,
  "amount" double precision,
  "currency" text,
  "occurredAt" timestamp,
  "sourceKey" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "OrderMailEvent_source_key" ON "OrderMailEvent" ("orderMailId", "sourceKey");
CREATE INDEX "OrderMailEvent_order_idx" ON "OrderMailEvent" ("orderId");

CREATE TABLE "OrderMailAttachment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderMailId" uuid NOT NULL REFERENCES "OrderMail"("id"),
  "providerAttachmentId" text NOT NULL,
  "filename" text NOT NULL,
  "mimeType" text NOT NULL,
  "checksum" text NOT NULL,
  "pendingDataBase64Url" text,
  "imageId" uuid REFERENCES "Image"("id"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "OrderMailAttachment_provider_key" ON "OrderMailAttachment" ("orderMailId", "providerAttachmentId");

CREATE TABLE "PurchasePaymentEvidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchaseId" uuid NOT NULL REFERENCES "Purchase"("id"),
  "sourceClaimId" uuid NOT NULL REFERENCES "ImportSourceClaim"("id"),
  "amount" double precision NOT NULL,
  "chargedAt" timestamp,
  "cardLastFour" text,
  "description" text,
  "evidenceIndex" integer NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "PurchasePaymentEvidence_source_index_key" ON "PurchasePaymentEvidence" ("sourceClaimId", "evidenceIndex");
CREATE INDEX "PurchasePaymentEvidence_purchase_idx" ON "PurchasePaymentEvidence" ("purchaseId");

ALTER TABLE "AiUsage" ADD COLUMN "jobKind" text, ADD COLUMN "jobId" text;
CREATE INDEX "AiUsage_job_idx" ON "AiUsage" ("jobKind", "jobId");

COMMIT;

-- Verify after applying:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN
  ('VendorAccount','ImportRun','ImportSourceClaim','ImportRunMutation','ImportFinding','ImportHunt','MerchantVendorRule','MailboxCursor','OrderMail','OrderMailEvent','OrderMailAttachment','PurchasePaymentEvidence')
ORDER BY table_name;
