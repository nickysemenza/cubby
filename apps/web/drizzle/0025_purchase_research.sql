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
ALTER TABLE "RunEvidence" DROP CONSTRAINT "RunEvidence_kind_check";
--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" DROP CONSTRAINT "ImportSourceClaim_purchaseId_Purchase_id_fk";
--> statement-breakpoint
DROP INDEX "ImportSourceClaim_purchase_idx";
--> statement-breakpoint
DROP INDEX "MailboxCursor_party_provider_key";
--> statement-breakpoint
DROP INDEX "OrderMail_party_message_key";
--> statement-breakpoint
ALTER TABLE "Purchase" ALTER COLUMN "date" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "MailboxCursor" ADD COLUMN "mailboxId" text;
--> statement-breakpoint
ALTER TABLE "MailboxCursor" ADD COLUMN "coverage" jsonb;
--> statement-breakpoint
ALTER TABLE "OrderMail" ADD COLUMN "mailboxId" text;
--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD CONSTRAINT "ImportSourceOrder_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES "public"."ImportSourceClaim"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD CONSTRAINT "ImportSourceOrder_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES "public"."OrderMail"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_targetId_RunTarget_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."RunTarget"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_evidenceId_RunEvidence_id_fk" FOREIGN KEY ("evidenceId") REFERENCES "public"."RunEvidence"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "ImportSourceOrder_source_order_key" ON "ImportSourceOrder" USING btree ("sourceClaimId","orderKey");
--> statement-breakpoint
CREATE INDEX "ImportSourceOrder_purchase_idx" ON "ImportSourceOrder" USING btree ("purchaseId");
--> statement-breakpoint
CREATE UNIQUE INDEX "MailboxMessage_mailbox_message_key" ON "MailboxMessage" USING btree ("ledgerPartyId","provider","mailboxId","messageId");
--> statement-breakpoint
CREATE INDEX "MailboxMessage_pending_idx" ON "MailboxMessage" USING btree ("ledgerPartyId","mailboxId","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "RunFactEvidence_claim_key" ON "RunFactEvidence" USING btree ("targetId","evidenceId","fieldPath","valueFingerprint");
--> statement-breakpoint
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
CREATE UNIQUE INDEX "MailboxCursor_party_provider_mailbox_key" ON "MailboxCursor" USING btree ("ledgerPartyId","provider","mailboxId");
--> statement-breakpoint
CREATE UNIQUE INDEX "OrderMail_mailbox_message_key" ON "OrderMail" USING btree ("ledgerPartyId","mailboxId","messageId");
--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" DROP COLUMN "purchaseId";
--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" DROP COLUMN "outputFingerprint";
--> statement-breakpoint
ALTER TABLE "RunEvidence" ADD CONSTRAINT "RunEvidence_kind_check" CHECK ("RunEvidence"."kind" IN ('browser_capture', 'web_page', 'mail_message', 'gmail_attachment', 'manual_upload'));
--> statement-breakpoint
DROP INDEX "PurchasePaymentEvidence_source_index_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "PurchasePaymentEvidence_source_purchase_index_key" ON "PurchasePaymentEvidence" USING btree ("sourceClaimId","purchaseId","evidenceIndex");
--> statement-breakpoint
ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_entityKind_check";
--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "runId" uuid;
--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_entityKind_check" CHECK ("RunTarget"."entityKind" IN ('purchase', 'product', 'image', 'run'));
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_import_party_check";
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";
--> statement-breakpoint
ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_outcome_check";
--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_import_party_check" CHECK ("Run"."purpose" NOT IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'mail_discovery') OR ("Run"."ledgerPartyId" IS NOT NULL AND "Run"."actorLedgerPartyShortcode" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'background', 'file_import', 'mail_search', 'mail_discovery'));
--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_outcome_check" CHECK ("RunTarget"."outcome" IS NULL OR "RunTarget"."outcome" IN ('replayed', 'raw_evidence_drift', 'semantic_drift', 'enriched', 'unavailable', 'skipped', 'attached', 'verified', 'partially_verified', 'researched_with_gaps', 'ambiguous', 'temporarily_blocked', 'no_source_found', 'unrelated'));
--> statement-breakpoint
DROP INDEX "RunTarget_run_entity_key";
--> statement-breakpoint
ALTER TABLE "RunTarget" ADD COLUMN "workKey" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "RunTarget_run_entity_key" ON "RunTarget" USING btree ("runId","entityId","workKey");
--> statement-breakpoint
DROP INDEX "Run_one_active_mail_discovery";
--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_mail_discovery" ON "Run" USING btree ("ledgerPartyId",COALESCE("input"->>'mailboxId', '')) WHERE "Run"."purpose" = 'mail_discovery' AND "Run"."status" = 'running';
--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "cause" text;
--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "attempt" integer;
--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "parentRunId" uuid;
--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_parentRunId_Run_id_fk" FOREIGN KEY ("parentRunId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "Run_parent_started_idx" ON "Run" USING btree ("parentRunId","startedAt");
--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_cause_check" CHECK ("Run"."cause" IN ('member_request', 'scheduled', 'source_discovered', 'import_completed', 'evidence_changed', 'retry'));
--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_attempt_positive" CHECK ("Run"."attempt" IS NULL OR "Run"."attempt" > 0);
--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD COLUMN "originalOrder" jsonb;
--> statement-breakpoint
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
ALTER TABLE "Run" ADD COLUMN "retiredAt" timestamp;
--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "retirementReason" text;
--> statement-breakpoint
ALTER TABLE "ResearchRetention" ADD CONSTRAINT "ResearchRetention_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ResearchRetention" ADD CONSTRAINT "ResearchRetention_workRef_RunTarget_id_fk" FOREIGN KEY ("workRef") REFERENCES "public"."RunTarget"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ResearchRetention" ADD CONSTRAINT "ResearchRetention_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ResearchSourceExposure" ADD CONSTRAINT "ResearchSourceExposure_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ResearchSourceExposure" ADD CONSTRAINT "ResearchSourceExposure_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "ResearchRetention_source_checksum_key" ON "ResearchRetention" USING btree ("ledgerPartyId","orderMailId","checksum");
--> statement-breakpoint
CREATE INDEX "ResearchRetention_phase_idx" ON "ResearchRetention" USING btree ("phase");
--> statement-breakpoint
CREATE UNIQUE INDEX "ResearchSourceExposure_run_source_key" ON "ResearchSourceExposure" USING btree ("runId","orderMailId","checksum");
--> statement-breakpoint
CREATE INDEX "ResearchSourceExposure_source_idx" ON "ResearchSourceExposure" USING btree ("ledgerPartyId","orderMailId","checksum");
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ALTER COLUMN "support" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD COLUMN "supportRetiredAt" timestamp;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_support_retirement_check" CHECK (("RunFactEvidence"."support" IS NOT NULL AND "RunFactEvidence"."supportRetiredAt" IS NULL) OR ("RunFactEvidence"."support" IS NULL AND "RunFactEvidence"."supportRetiredAt" IS NOT NULL));
--> statement-breakpoint
CREATE TABLE "ImportSourceProduct" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceOrderId" uuid NOT NULL,
	"lineIndex" integer NOT NULL,
	"productId" uuid NOT NULL,
	CONSTRAINT "ImportSourceProduct_lineIndex_check" CHECK ("ImportSourceProduct"."lineIndex" >= 0)
);
--> statement-breakpoint
ALTER TABLE "OrderMail" ALTER COLUMN "receivedAt" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "ImportSourceProduct" ADD CONSTRAINT "ImportSourceProduct_sourceOrderId_ImportSourceOrder_id_fk" FOREIGN KEY ("sourceOrderId") REFERENCES "public"."ImportSourceOrder"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ImportSourceProduct" ADD CONSTRAINT "ImportSourceProduct_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "ImportSourceProduct_sourceOrder_line_key" ON "ImportSourceProduct" USING btree ("sourceOrderId","lineIndex");
--> statement-breakpoint
CREATE INDEX "ImportSourceProduct_product_idx" ON "ImportSourceProduct" USING btree ("productId");
--> statement-breakpoint
-- Historical identities include soft-deleted Products and Purchases. Validate
-- every binding before removing its JSON representation; missing or conflicting
-- references require repair rather than silent loss of original order evidence.
DO $$
DECLARE
  source_record record;
  binding jsonb;
  binding_index numeric;
  binding_product uuid;
BEGIN
  FOR source_record IN
    SELECT id, "originalOrder" FROM "ImportSourceOrder"
    WHERE "originalOrder" ? 'productLines'
  LOOP
    IF jsonb_typeof(source_record."originalOrder"->'productLines') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid original Product binding array on source %', source_record.id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(source_record."originalOrder"->'productLines') item
      GROUP BY item->>'lineIndex' HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Duplicate original Product binding on source %', source_record.id;
    END IF;
    FOR binding IN SELECT value FROM jsonb_array_elements(source_record."originalOrder"->'productLines')
    LOOP
      IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
        OR jsonb_typeof(binding->'lineIndex') IS DISTINCT FROM 'number'
        OR (binding->>'lineIndex') !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(binding->'productId') IS DISTINCT FROM 'string'
        OR (binding->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid original Product binding on source %', source_record.id;
      END IF;
      binding_index := (binding->>'lineIndex')::numeric;
      IF binding_index > 2147483647 THEN
        RAISE EXCEPTION 'Invalid original Product line index on source %', source_record.id;
      END IF;
      IF source_record."originalOrder" #> ARRAY['extraction','candidate','lines',binding_index::integer::text] IS NULL THEN
        RAISE EXCEPTION 'Original Product binding has no ordered line on source %', source_record.id;
      END IF;
      binding_product := (binding->>'productId')::uuid;
      IF NOT EXISTS (SELECT 1 FROM "Product" WHERE id = binding_product) THEN
        RAISE EXCEPTION 'Original Product binding references a missing Product on source %', source_record.id;
      END IF;
      IF EXISTS (SELECT 1 FROM "ImportSourceProduct" WHERE "sourceOrderId" = source_record.id
        AND "lineIndex" = binding_index::integer AND "productId" <> binding_product) THEN
        RAISE EXCEPTION 'Conflicting original Product binding on source %', source_record.id;
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
INSERT INTO "ImportSourceProduct" ("sourceOrderId", "lineIndex", "productId")
SELECT source.id, (binding.value->>'lineIndex')::integer, (binding.value->>'productId')::uuid
FROM "ImportSourceOrder" source
CROSS JOIN LATERAL jsonb_array_elements(source."originalOrder"->'productLines') binding
WHERE source."originalOrder" ? 'productLines'
ON CONFLICT ("sourceOrderId", "lineIndex") DO NOTHING;
--> statement-breakpoint
UPDATE "ImportSourceOrder" SET "originalOrder" = "originalOrder" - 'productLines'
WHERE "originalOrder" ? 'productLines';
--> statement-breakpoint
ALTER TABLE "RunEvidence" DROP CONSTRAINT "RunEvidence_kind_check";
--> statement-breakpoint
ALTER TABLE "RunEvidence" ADD CONSTRAINT "RunEvidence_kind_check" CHECK ("RunEvidence"."kind" IN ('browser_capture', 'web_page', 'mail_message', 'gmail_attachment', 'manual_upload', 'upload_evidence'));
--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD COLUMN "canonicalClaimId" uuid;
--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_canonicalClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("canonicalClaimId") REFERENCES "public"."ImportSourceClaim"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ImportSourceClaim_canonical_idx" ON "ImportSourceClaim" USING btree ("canonicalClaimId");
--> statement-breakpoint
ALTER TABLE "ImportSourceClaim" ADD CONSTRAINT "ImportSourceClaim_canonical_self_check" CHECK ("ImportSourceClaim"."canonicalClaimId" IS NULL OR "ImportSourceClaim"."canonicalClaimId" <> "ImportSourceClaim"."id");
--> statement-breakpoint
-- Custom SQL migration file, put your code below! --
-- Map source identity only. Association, payment, original-byte and Run owners
-- retain their IDs; a current Google connection cannot identify old mail.
CREATE TEMP TABLE "_HistoricalMailClaim" ON COMMIT DROP AS
SELECT c."id" AS "claimId", m."id" AS "orderMailId", c."ledgerPartyId",
  m."mailboxId", m."messageId", m."rawChecksum",
  'gmail:' || m."mailboxId" || ':' || m."messageId" AS "canonicalKey",
  EXISTS (
    SELECT 1 FROM "Run" r
    JOIN "LedgerParty" owner ON owner."id" = r."ledgerPartyId"
      AND owner."userId" = r."actorUserId" AND owner."kind" = 'member'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN r."input"->>'kind' = 'order_mail_import' THEN
        CASE WHEN jsonb_typeof(r."input"->'orders') = 'array'
          THEN r."input"->'orders' ELSE jsonb_build_array(r."input") END
        ELSE '[]'::jsonb END
    ) selection
    JOIN "OrderMailEvent" e ON e."id"::text = selection->>'eventId'
    WHERE r."id" IN (c."firstRunId", c."lastRunId")
      AND r."ledgerPartyId" = c."ledgerPartyId"
      AND e."orderMailId" = m."id"
      AND selection->>'evidenceChecksum' = m."rawChecksum"
      AND c."checksum" = m."rawChecksum"
      AND selection->>'orderId' = e."orderId"
      AND c."externalKey" = 'gmail:' || m."messageId" || ':order:' || e."orderId"
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceOrder" o JOIN "Purchase" p ON p."id" = o."purchaseId"
    WHERE o."sourceClaimId" = c."id"
      AND (o."checksum" <> m."rawChecksum" OR p."orderId" IS NULL
        OR o."orderKey" <> p."vendorId"::text || '/order/' || p."orderId"
        OR c."externalKey" <> 'gmail:' || m."messageId" || ':order:' || p."orderId")
  ) AS "proved"
FROM "ImportSourceClaim" c JOIN "OrderMail" m
  ON m."ledgerPartyId" = c."ledgerPartyId"
  AND m."mailboxId" = 'legacy:' || c."ledgerPartyId"::text
  AND left(c."externalKey", length('gmail:' || m."messageId" || ':order:'))
    = 'gmail:' || m."messageId" || ':order:'
WHERE c."kind" = 'mail_message' AND c."canonicalClaimId" IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE "_HistoricalMailFamily" ON COMMIT DROP AS
WITH candidates AS (
  SELECT h."orderMailId", h."ledgerPartyId", h."mailboxId", h."messageId",
    h."rawChecksum", h."canonicalKey", bool_and(h."proved") AS "proved",
    array_agg(h."claimId") AS "claimIds", min(h."claimId"::text)::uuid AS "historyOwner"
  FROM "_HistoricalMailClaim" h
  GROUP BY h."orderMailId", h."ledgerPartyId", h."mailboxId", h."messageId", h."rawChecksum", h."canonicalKey"
)
SELECT c.*, COALESCE(existing."id", gen_random_uuid()) AS "rootId",
  c."proved" AND (existing."id" IS NULL OR
    (existing."canonicalClaimId" IS NULL AND existing."checksum" = c."rawChecksum"))
  AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceOrder" o
    WHERE o."sourceClaimId" = ANY(c."claimIds") OR o."sourceClaimId" IN (
      SELECT member."id" FROM "ImportSourceClaim" member
      WHERE member."id" = existing."id" OR member."canonicalClaimId" = existing."id"
    )
    GROUP BY o."orderKey" HAVING count(*) > 1
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceClaim" member
    WHERE (member."id" = existing."id" OR member."canonicalClaimId" = existing."id")
      AND (member."ledgerPartyId" <> c."ledgerPartyId" OR member."kind" <> 'mail_message')
  ) AND NOT EXISTS (
    -- Reparenting a candidate with children would create a forbidden alias chain.
    SELECT 1 FROM "ImportSourceClaim" descendant
    WHERE descendant."canonicalClaimId" = ANY(c."claimIds")
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceClaim" descendant
    JOIN "ImportSourceClaim" member ON member."id" = descendant."canonicalClaimId"
    WHERE member."canonicalClaimId" = existing."id"
  ) AS "safe"
FROM candidates c LEFT JOIN "ImportSourceClaim" existing
  ON existing."ledgerPartyId" = c."ledgerPartyId" AND existing."kind" = 'mail_message'
  AND existing."externalKey" = c."canonicalKey";
--> statement-breakpoint
-- Keep every historical textual key: prepared extracts and past operations
-- retain those identities even when their association UUIDs stay unchanged.
INSERT INTO "ImportSourceClaim" ("id", "ledgerPartyId", "kind", "externalKey",
  "checksum", "firstRunId", "lastRunId")
SELECT f."rootId", f."ledgerPartyId", 'mail_message', f."canonicalKey",
  f."rawChecksum", history."firstRunId", history."lastRunId"
FROM "_HistoricalMailFamily" f
JOIN "ImportSourceClaim" history ON history."id" = f."historyOwner"
WHERE f."safe" AND NOT EXISTS (
  SELECT 1 FROM "ImportSourceClaim" existing WHERE existing."id" = f."rootId"
);
--> statement-breakpoint
UPDATE "ImportSourceClaim" c SET "canonicalClaimId" = f."rootId"
FROM "_HistoricalMailFamily" f
WHERE f."safe" AND c."id" = ANY(f."claimIds") AND c."id" <> f."rootId";
--> statement-breakpoint
-- A disposition blocks both admission and disposal independently of findings.
INSERT INTO "MailboxMessage" ("ledgerPartyId", "mailboxId", "messageId", "checksum",
  "classification", "classificationVersion", "status", "orderMailId")
SELECT f."ledgerPartyId", f."mailboxId", f."messageId", f."rawChecksum",
  'related', 'legacy-source-identity-unresolved/v1', 'blocked', f."orderMailId"
FROM "_HistoricalMailFamily" f WHERE NOT f."safe"
ON CONFLICT ("ledgerPartyId", "provider", "mailboxId", "messageId") DO UPDATE
SET "classification" = 'related', "classificationVersion" = 'legacy-source-identity-unresolved/v1',
  "status" = CASE WHEN "MailboxMessage"."status" IN ('deleted', 'excluded')
    THEN "MailboxMessage"."status" ELSE 'blocked' END,
  "orderMailId" = EXCLUDED."orderMailId", "checksum" = EXCLUDED."checksum";
--> statement-breakpoint
-- Missing originals also leave an inspectable finding. Dismissal is not proof.
INSERT INTO "RunFinding" ("runId", "ledgerPartyId", "entityId", "entityKind", "kind",
  "summary", "proposedFix", "evidenceFingerprint")
SELECT c."firstRunId", c."ledgerPartyId", c."firstRunId", 'run', 'other',
  'Historical mail source ownership needs review: retained original, frozen selection, or order ownership could not be verified.',
  NULL, 'legacy-source-identity:' || md5(c."id"::text || ':' || c."externalKey" || ':' || c."checksum")
FROM "ImportSourceClaim" c
WHERE c."kind" = 'mail_message' AND c."canonicalClaimId" IS NULL
  AND c."externalKey" ~ '^gmail:[^:]+:order:.+'
ON CONFLICT ("ledgerPartyId", "entityKind", "entityId", "kind", "evidenceFingerprint")
  WHERE "status" = 'open' DO NOTHING;
--> statement-breakpoint
DROP INDEX "RunFactEvidence_claim_key";
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD COLUMN "entityKind" text;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD COLUMN "entityId" uuid;
--> statement-breakpoint
CREATE INDEX "RunFactEvidence_subject_idx" ON "RunFactEvidence" USING btree ("entityKind","entityId");
--> statement-breakpoint
CREATE UNIQUE INDEX "RunFactEvidence_claim_key" ON "RunFactEvidence" USING btree ("targetId","evidenceId","entityKind","entityId","fieldPath","valueFingerprint");
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_entityKind_check" CHECK ("RunFactEvidence"."entityKind" IN ('purchase', 'product', 'image', 'run'));
--> statement-breakpoint
-- Existing proof is about its entity task. Preserve every accepted value and
-- source reference while making the canonical subject explicit.
UPDATE "RunFactEvidence" AS proof
SET "entityKind" = target."entityKind", "entityId" = target."entityId"
FROM "RunTarget" AS target
WHERE proof."targetId" = target.id
  AND proof."entityKind" IS NULL AND proof."entityId" IS NULL;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ALTER COLUMN "entityKind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ALTER COLUMN "entityId" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Apply with purchase/mail writers and deliveries quiesced. These active Runs
-- predate the replacement contract; preserve their evidence and decisions, but
-- release admission for fresh, explicitly converted successor work.
UPDATE "Run"
SET "status" = 'needs_review',
    "endedAt" = COALESCE("endedAt", now()),
    "dispatchError" = concat_ws(E'\n',
      "dispatchError",
      CASE WHEN "failureCode" IS NOT NULL THEN 'Previous failure code: ' || "failureCode" END,
      'Interrupted legacy research requires a fresh admitted replacement Run.'),
    "failureCode" = 'research_rewrite_required'
WHERE "deletedAt" IS NULL AND "retiredAt" IS NULL
  AND "purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'mail_search', 'mail_discovery')
  AND "status" IN ('running', 'paused_auth', 'paused_offline', 'paused_approval');
