SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint
CREATE TABLE "SourceOrderObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceClaimId" uuid NOT NULL,
	"orderKey" text NOT NULL,
	"purchaseId" uuid NOT NULL,
	"vendorId" uuid NOT NULL,
	"runId" uuid,
	"checksum" text NOT NULL,
	"extraction" jsonb NOT NULL,
	"productBindings" jsonb NOT NULL,
	"primaryDocumentImageId" uuid,
	"screenshotImageId" uuid,
	"contentFingerprint" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "SourceOrderObservation_checksum_check" CHECK ("SourceOrderObservation"."checksum" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";--> statement-breakpoint
ALTER TABLE "MailboxMessage" DROP CONSTRAINT "MailboxMessage_classification_check";--> statement-breakpoint
ALTER TABLE "MailboxMessage" DROP CONSTRAINT "MailboxMessage_classification_stage_check";--> statement-breakpoint
ALTER TABLE "MailboxMessage" DROP CONSTRAINT "MailboxMessage_status_check";--> statement-breakpoint
ALTER TABLE "VendorAccount" DROP CONSTRAINT "VendorAccount_browser_check";--> statement-breakpoint
ALTER TABLE "VendorAccount" DROP CONSTRAINT "VendorAccount_status_check";--> statement-breakpoint
ALTER TABLE "MailboxMessage" ALTER COLUMN "classification" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ALTER COLUMN "classificationVersion" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "OrderMail" ALTER COLUMN "sender" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "OrderMail" ALTER COLUMN "subject" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "shortcode" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "sender" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "receivedAt" timestamp;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "threadId" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "historyId" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "deletedAt" timestamp;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "executionPolicy" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "searchOrigin" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "searchExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "contentClearedAt" timestamp;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "liveProgress" jsonb;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "progressHistory" jsonb;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "progressEventIds" jsonb;--> statement-breakpoint
ALTER TABLE "Run" ADD COLUMN "heartbeatAt" timestamp;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_sourceClaimId_ImportSourceClaim_id_fk" FOREIGN KEY ("sourceClaimId") REFERENCES "public"."ImportSourceClaim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_primaryDocumentImageId_Image_id_fk" FOREIGN KEY ("primaryDocumentImageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SourceOrderObservation" ADD CONSTRAINT "SourceOrderObservation_screenshotImageId_Image_id_fk" FOREIGN KEY ("screenshotImageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "SourceOrderObservation_content_key" ON "SourceOrderObservation" USING btree ("sourceClaimId","orderKey","checksum","contentFingerprint");--> statement-breakpoint
CREATE INDEX "SourceOrderObservation_purchase_idx" ON "SourceOrderObservation" USING btree ("purchaseId");--> statement-breakpoint
CREATE UNIQUE INDEX "MailboxMessage_shortcode_unique" ON "MailboxMessage" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "MailboxMessage_orderMailId_key" ON "MailboxMessage" USING btree ("orderMailId") WHERE "MailboxMessage"."orderMailId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "MailboxMessage_ledgerPartyId_receivedAt_idx" ON "MailboxMessage" USING btree ("ledgerPartyId","receivedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "MailboxMessage_runId_idx" ON "MailboxMessage" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "MailboxMessage_orderMailId_idx" ON "MailboxMessage" USING btree ("orderMailId");--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email'));--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' WHEN 'email' THEN "Entity"."shortcode" LIKE 'EML-%' ELSE false END);--> statement-breakpoint
-- BEGIN EMAIL IDENTITY BACKFILL
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "MailboxMessage" e JOIN "OrderMail" o ON o.id = e."orderMailId"
    WHERE e."ledgerPartyId" <> o."ledgerPartyId" OR e."mailboxId" <> o."mailboxId" OR e."messageId" <> o."messageId"
  ) THEN RAISE EXCEPTION 'Email original mapping crosses source identity or ownership'; END IF;
END $$;
--> statement-breakpoint
--> statement-breakpoint
UPDATE "MailboxMessage" e
SET "orderMailId" = o.id
FROM "OrderMail" o
WHERE e."orderMailId" IS NULL AND e.provider = 'gmail'
  AND e."ledgerPartyId" = o."ledgerPartyId" AND e."mailboxId" = o."mailboxId" AND e."messageId" = o."messageId";
--> statement-breakpoint
UPDATE "MailboxMessage" e
SET sender = coalesce(e.sender, o.sender), subject = coalesce(e.subject, o.subject),
    "receivedAt" = coalesce(e."receivedAt", o."receivedAt"),
    "threadId" = coalesce(e."threadId", o."threadId"), "historyId" = coalesce(e."historyId", o."historyId")
FROM "OrderMail" o WHERE e."orderMailId" = o.id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.cubby_mint_email_shortcode() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE code text; alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; bytes bytea;
BEGIN
  LOOP
    bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    SELECT 'EML-' || string_agg(substr(alphabet, 1 + get_byte(bytes, position) % length(alphabet), 1), '' ORDER BY position)
    INTO code FROM generate_series(0, 4) position;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM "MailboxMessage" WHERE shortcode = code)
      AND NOT EXISTS (SELECT 1 FROM "Entity" WHERE shortcode = code);
  END LOOP;
  RETURN code;
END $$;
--> statement-breakpoint

DO $$ DECLARE original "OrderMail"%ROWTYPE; record_id uuid;
BEGIN
  FOR original IN SELECT o.* FROM "OrderMail" o WHERE NOT EXISTS (
    SELECT 1 FROM "MailboxMessage" e WHERE e.provider = 'gmail' AND e."ledgerPartyId" = o."ledgerPartyId"
      AND e."mailboxId" = o."mailboxId" AND e."messageId" = o."messageId"
  ) ORDER BY o.id LOOP
    INSERT INTO "MailboxMessage" (id, shortcode, "ledgerPartyId", provider, "mailboxId", "messageId", checksum,
      classification, "classificationVersion", status, "orderMailId", sender, subject, "receivedAt", "threadId", "historyId", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), pg_temp.cubby_mint_email_shortcode(), original."ledgerPartyId", 'gmail', original."mailboxId", original."messageId", original."rawChecksum",
      NULL, NULL, 'pending', original.id, original.sender, original.subject, original."receivedAt", original."threadId", original."historyId", original."createdAt", original."updatedAt");
  END LOOP;
  FOR record_id IN SELECT id FROM "MailboxMessage" WHERE shortcode IS NULL ORDER BY id LOOP
    UPDATE "MailboxMessage" SET shortcode = pg_temp.cubby_mint_email_shortcode() WHERE id = record_id;
  END LOOP;
END $$;
--> statement-breakpoint
--> statement-breakpoint
INSERT INTO "Entity" (id, kind, shortcode, "createdAt", "deletedAt")
SELECT id, 'email', shortcode, "createdAt", "deletedAt" FROM "MailboxMessage"
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "MailboxMessage" e JOIN "Entity" identity ON identity.id = e.id
    WHERE identity.kind <> 'email' OR identity.shortcode <> e.shortcode)
  THEN RAISE EXCEPTION 'Email identity registration conflicts with existing entity'; END IF;
END $$;
--> statement-breakpoint
-- END EMAIL IDENTITY BACKFILL

--> statement-breakpoint
ALTER TABLE "MailboxMessage" ALTER COLUMN shortcode SET NOT NULL;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_executionPolicy_check" CHECK ("MailboxMessage"."executionPolicy" IS NULL OR "MailboxMessage"."executionPolicy" IN ('classification_only', 'import'));--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_searchOrigin_check" CHECK ("MailboxMessage"."searchOrigin" IS NULL OR "MailboxMessage"."searchOrigin" IN ('member_search', 'discovery'));--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_classification_check" CHECK ("classification" IN ('related', 'unrelated', 'uncertain'));--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_classification_stage_check" CHECK ("classificationStage" IS NULL OR "classificationStage" IN ('rule', 'jev', 'model', 'resolution'));--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_status_check" CHECK ("status" IN ('pending', 'researching', 'completed', 'blocked', 'deleted', 'excluded'));--> statement-breakpoint
UPDATE "VendorAccount" SET status = 'disabled' WHERE status IN ('paused_auth', 'paused_offline');--> statement-breakpoint
ALTER TABLE "VendorAccount" ADD CONSTRAINT "VendorAccount_status_check" CHECK ("VendorAccount"."status" IN ('active', 'disabled'));
--> statement-breakpoint
-- Old progress remains displayable without inheriting a new attempt's sequence.
WITH ordered AS (
  SELECT p.*, row_number() OVER (PARTITION BY "runId" ORDER BY "createdAt", id) AS position,
    count(*) OVER (PARTITION BY "runId") AS total
  FROM "RunProgress" p
), events AS (
  SELECT *, jsonb_build_object('eventId', "eventId", 'generation', 'legacy', 'sequence', position,
    'phase', phase, 'currentItem', "currentItem", 'awaitingApproval', "awaitingApproval", 'detail', detail,
    'createdAt', to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS event
  FROM ordered
), grouped AS (
  SELECT "runId", jsonb_agg("eventId" ORDER BY position) AS ids,
    jsonb_agg(event ORDER BY position) FILTER (WHERE position > total - 100) AS history,
    (array_agg(event ORDER BY position DESC))[1] AS live, max("createdAt") AS heartbeat
  FROM events GROUP BY "runId"
)
UPDATE "Run" r SET "progressEventIds" = grouped.ids, "progressHistory" = grouped.history,
  "liveProgress" = grouped.live, "heartbeatAt" = grouped.heartbeat
FROM grouped WHERE r.id = grouped."runId";

CREATE OR REPLACE FUNCTION "entity_identity_on_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "Entity" ("id", "kind", "shortcode", "createdAt", "deletedAt")
  VALUES (NEW."id", TG_ARGV[0], NEW."shortcode", NEW."createdAt", NEW."deletedAt");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_soft_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity" SET "deletedAt" = NEW."deletedAt" WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity"
  SET "deletedAt" = COALESCE("deletedAt", OLD."deletedAt", now())
  WHERE "id" = OLD."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('cookbook');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Cookbook"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('device');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Device"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "MailboxMessage"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('email');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "MailboxMessage"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "MailboxMessage"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('expense');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Expense"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('financialAccount');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "FinancialAccount"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('financialTransaction');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "FinancialTransaction"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('gardenEntry');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "GardenEntry"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Image"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('image');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Image"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Image"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ingredient');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Ingredient"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('inventory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "InventoryEntry"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ledgerParty');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "LedgerParty"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ledgerTransfer');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "LedgerTransfer"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('location');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Location"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('meal');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Meal"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('plant');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Plant"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('planting');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Planting"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('product');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Product"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('productCategory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "ProductCategory"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('project');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Project"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('purchase');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Purchase"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('recipe');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Recipe"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('run');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Run"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "SpendingCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('spendingCategory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "SpendingCategory"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "SpendingCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('task');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Task"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('vendor');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Vendor"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "VendorAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('vendorAccount');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "VendorAccount"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "VendorAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('wish');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Wish"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE FUNCTION "entity_link_require_live_endpoints"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Entity"
    WHERE "id" IN (NEW."fromEntityId", NEW."toEntityId")
      AND "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EntityLink % (%) names a deleted entity: % -> %',
      NEW."id", NEW."kind", NEW."fromEntityId", NEW."toEntityId"
      USING ERRCODE = '23503', CONSTRAINT = 'EntityLink_live_endpoints_check';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON "EntityLink"
  FOR EACH ROW WHEN (NEW."deletedAt" IS NULL)
  EXECUTE FUNCTION "entity_link_require_live_endpoints"();

CREATE OR REPLACE FUNCTION "Product_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."tags" IS DISTINCT FROM NEW."tags" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'tags'
      AND "status" = 'pending';
  END IF;
  IF OLD."categoryId" IS DISTINCT FROM NEW."categoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."ingredientId" IS DISTINCT FROM NEW."ingredientId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."growsPlantId" IS DISTINCT FROM NEW."growsPlantId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Product_supersede_suggestions_after_update" ON "Product";
CREATE TRIGGER "Product_supersede_suggestions_after_update" AFTER UPDATE OF "tags", "categoryId", "ingredientId", "growsPlantId" ON "Product" FOR EACH ROW EXECUTE FUNCTION "Product_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Location_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."type" IS DISTINCT FROM NEW."type" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Location_supersede_suggestions_after_update" ON "Location";
CREATE TRIGGER "Location_supersede_suggestions_after_update" AFTER UPDATE OF "type" ON "Location" FOR EACH ROW EXECUTE FUNCTION "Location_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "InventoryEntry_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."locationId" IS DISTINCT FROM NEW."locationId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'inventory'
      AND "recordId" = NEW."id"
      AND "field" = 'locationId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "InventoryEntry_supersede_suggestions_after_update" ON "InventoryEntry";
CREATE TRIGGER "InventoryEntry_supersede_suggestions_after_update" AFTER UPDATE OF "locationId" ON "InventoryEntry" FOR EACH ROW EXECUTE FUNCTION "InventoryEntry_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Meal_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."mealType" IS DISTINCT FROM NEW."mealType" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealType'
      AND "status" = 'pending';
  END IF;
  IF OLD."mealKind" IS DISTINCT FROM NEW."mealKind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealKind'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Meal_supersede_suggestions_after_update" ON "Meal";
CREATE TRIGGER "Meal_supersede_suggestions_after_update" AFTER UPDATE OF "mealType", "mealKind" ON "Meal" FOR EACH ROW EXECUTE FUNCTION "Meal_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Project_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultTrade" IS DISTINCT FROM NEW."defaultTrade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Project_supersede_suggestions_after_update" ON "Project";
CREATE TRIGGER "Project_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "kind", "defaultTrade" ON "Project" FOR EACH ROW EXECUTE FUNCTION "Project_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Task_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."subjectProductId" IS DISTINCT FROM NEW."subjectProductId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'subjectProductId'
      AND "status" = 'pending';
  END IF;
  IF OLD."trade" IS DISTINCT FROM NEW."trade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Task_supersede_suggestions_after_update" ON "Task";
CREATE TRIGGER "Task_supersede_suggestions_after_update" AFTER UPDATE OF "projectId", "subjectProductId", "trade" ON "Task" FOR EACH ROW EXECUTE FUNCTION "Task_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Vendor_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingProfile" IS DISTINCT FROM NEW."spendingProfile" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingProfile'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultSpendingCategoryId" IS DISTINCT FROM NEW."defaultSpendingCategoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Vendor_supersede_suggestions_after_update" ON "Vendor";
CREATE TRIGGER "Vendor_supersede_suggestions_after_update" AFTER UPDATE OF "spendingProfile", "defaultSpendingCategoryId", "evidenceExpectation" ON "Vendor" FOR EACH ROW EXECUTE FUNCTION "Vendor_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Purchase_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultProjectId" IS DISTINCT FROM NEW."defaultProjectId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultProjectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultTrade" IS DISTINCT FROM NEW."defaultTrade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'vendorId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Purchase_supersede_suggestions_after_update" ON "Purchase";
CREATE TRIGGER "Purchase_supersede_suggestions_after_update" AFTER UPDATE OF "spendingCategoryId", "evidenceExpectation", "defaultProjectId", "defaultTrade", "vendorId" ON "Purchase" FOR EACH ROW EXECUTE FUNCTION "Purchase_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "FinancialTransaction_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "FinancialTransaction_supersede_suggestions_after_update" ON "FinancialTransaction";
CREATE TRIGGER "FinancialTransaction_supersede_suggestions_after_update" AFTER UPDATE OF "evidenceExpectation" ON "FinancialTransaction" FOR EACH ROW EXECUTE FUNCTION "FinancialTransaction_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Expense_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."lineKind" IS DISTINCT FROM NEW."lineKind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'lineKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."costType" IS DISTINCT FROM NEW."costType" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'costType'
      AND "status" = 'pending';
  END IF;
  IF OLD."trade" IS DISTINCT FROM NEW."trade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."purchaseId" IS DISTINCT FROM NEW."purchaseId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'vendor'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Expense_supersede_suggestions_after_update" ON "Expense";
CREATE TRIGGER "Expense_supersede_suggestions_after_update" AFTER UPDATE OF "spendingCategoryId", "lineKind", "costType", "trade", "projectId", "productId", "purchaseId" ON "Expense" FOR EACH ROW EXECUTE FUNCTION "Expense_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Planting_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'planting'
      AND "recordId" = NEW."id"
      AND "field" = 'status'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Planting_supersede_suggestions_after_update" ON "Planting";
CREATE TRIGGER "Planting_supersede_suggestions_after_update" AFTER UPDATE OF "status" ON "Planting" FOR EACH ROW EXECUTE FUNCTION "Planting_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "GardenEntry_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'gardenEntry'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "GardenEntry_supersede_suggestions_after_update" ON "GardenEntry";
CREATE TRIGGER "GardenEntry_supersede_suggestions_after_update" AFTER UPDATE OF "kind" ON "GardenEntry" FOR EACH ROW EXECUTE FUNCTION "GardenEntry_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "ProductCategory_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."feature" IS DISTINCT FROM NEW."feature" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'feature'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "ProductCategory_supersede_suggestions_after_update" ON "ProductCategory";
CREATE TRIGGER "ProductCategory_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "feature" ON "ProductCategory" FOR EACH ROW EXECUTE FUNCTION "ProductCategory_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "SpendingCategory_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."productExpectation" IS DISTINCT FROM NEW."productExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'productExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "SpendingCategory_supersede_suggestions_after_update" ON "SpendingCategory";
CREATE TRIGGER "SpendingCategory_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "evidenceExpectation", "productExpectation" ON "SpendingCategory" FOR EACH ROW EXECUTE FUNCTION "SpendingCategory_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Purchase_supersede_expense_vendor_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "Suggestion" AS s SET "status" = 'superseded', "updatedAt" = now()
    FROM "Expense" AS r
    WHERE s."entity" = 'expense' AND s."field" = 'vendor'
      AND s."status" = 'pending' AND r."id" = s."recordId" AND r."purchaseId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Purchase_supersede_expense_vendor_suggestions_after_update" ON "Purchase";
CREATE TRIGGER "Purchase_supersede_expense_vendor_suggestions_after_update" AFTER UPDATE OF "vendorId" ON "Purchase" FOR EACH ROW EXECUTE FUNCTION "Purchase_supersede_expense_vendor_suggestions_after_update"();

ALTER TABLE "Location" DROP CONSTRAINT IF EXISTS "Location_classification_type_productId_check";
ALTER TABLE "Location" ADD CONSTRAINT "Location_classification_type_productId_check" CHECK (("type" NOT IN ('furniture') OR "productId" IS NOT NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_productId_check" CHECK (("lineKind" NOT IN ('tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "productId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_spendingCategoryId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_spendingCategoryId_check" CHECK (("lineKind" NOT IN ('tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "spendingCategoryId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_projectId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_projectId_check" CHECK (("lineKind" NOT IN ('tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "projectId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineBasis_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineBasis_productId_check" CHECK (("lineBasis" NOT IN ('allocation') OR "productId" IS NULL));

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE TABLE "PhotoRunImage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"imageId" uuid NOT NULL,
	"workKey" text DEFAULT '' NOT NULL,
	"position" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"targetFingerprint" text NOT NULL,
	"outcome" text,
	"skipReason" text,
	"commitReceipt" jsonb,
	"preparedAt" timestamp,
	"completedAt" timestamp,
	"deviceWorkState" text,
	"deviceWorkAttempts" integer DEFAULT 0 NOT NULL,
	"deviceWorkError" text,
	"deviceWorkDeviceId" uuid,
	"deviceWorkUpdatedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "PhotoRunImage_state_check" CHECK ("PhotoRunImage"."state" IN ('pending', 'prepared', 'completed', 'skipped', 'unresolved', 'needs_evidence', 'unavailable')),
	CONSTRAINT "PhotoRunImage_outcome_check" CHECK ("PhotoRunImage"."outcome" IS NULL OR "PhotoRunImage"."outcome" IN ('attached', 'skipped')),
	CONSTRAINT "PhotoRunImage_device_state_check" CHECK ("PhotoRunImage"."deviceWorkState" IS NULL OR "PhotoRunImage"."deviceWorkState" IN ('queued', 'running', 'paused', 'failed', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD COLUMN "acceptedObservationId" uuid;--> statement-breakpoint
ALTER TABLE "PhotoRunImage" ADD CONSTRAINT "PhotoRunImage_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoRunImage" ADD CONSTRAINT "PhotoRunImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PhotoRunImage" ADD CONSTRAINT "PhotoRunImage_deviceWorkDeviceId_Device_id_fk" FOREIGN KEY ("deviceWorkDeviceId") REFERENCES "public"."Device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "PhotoRunImage_run_image_work_key" ON "PhotoRunImage" USING btree ("runId","imageId","workKey");--> statement-breakpoint
CREATE INDEX "PhotoRunImage_image_idx" ON "PhotoRunImage" USING btree ("imageId");--> statement-breakpoint
CREATE INDEX "PhotoRunImage_device_idx" ON "PhotoRunImage" USING btree ("deviceWorkDeviceId") WHERE "PhotoRunImage"."deviceWorkDeviceId" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ADD CONSTRAINT "ImportSourceOrder_acceptedObservationId_SourceOrderObservation_id_fk" FOREIGN KEY ("acceptedObservationId") REFERENCES "public"."SourceOrderObservation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ImportSourceOrder_acceptedObservation_idx" ON "ImportSourceOrder" USING btree ("acceptedObservationId");
--> statement-breakpoint
-- BEGIN TARGET OWNERSHIP BACKFILL
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "RunTarget" WHERE "entityKind" = 'image' AND
    ("outcome" IS NOT NULL AND "outcome" NOT IN ('attached','skipped') OR
     "diff" IS NOT NULL AND NOT ("diff" ? 'groupKey'))) THEN
    RAISE EXCEPTION 'Legacy photo receipts need explicit reconciliation before migration';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "PhotoRunImage" (id,"runId","imageId","workKey",position,state,"targetFingerprint",outcome,"skipReason","commitReceipt","preparedAt","completedAt","deviceWorkState","deviceWorkAttempts","deviceWorkError","deviceWorkDeviceId","deviceWorkUpdatedAt","createdAt","updatedAt")
SELECT id,"runId","entityId","workKey",position,state,"targetFingerprint",outcome,warning,diff,"preparedAt","completedAt","deviceWorkState","deviceWorkAttempts","deviceWorkError","deviceWorkDeviceId","deviceWorkUpdatedAt","createdAt","updatedAt"
FROM "RunTarget" WHERE "entityKind"='image' ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "RunOperation" ("runId","operationId",kind,"inputFingerprint",state,result,"completedAt","createdAt","updatedAt")
SELECT "runId",'migrated-target:'||id::text,'target_outcome',"targetFingerprint",'completed',
  jsonb_build_object('target',jsonb_build_object('entityKind',"entityKind",'entityId',"entityId",'workKey',"workKey",'state',state,'outcome',outcome,'warning',warning,'diff',diff,'completedAt',CASE WHEN "completedAt" IS NULL THEN NULL ELSE to_char("completedAt",'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,'targetFingerprint',"targetFingerprint",'sourceKind',"sourceKind",'sourceExternalKey',"sourceExternalKey",'vendorAccountId',"vendorAccountId",'evidenceFingerprint',"evidenceFingerprint",'position',position)),
  coalesce("completedAt","updatedAt"),"createdAt","updatedAt"
FROM "RunTarget" WHERE "entityKind" <> 'image'
ON CONFLICT ("runId","operationId") DO NOTHING;
-- END TARGET OWNERSHIP BACKFILL

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE TABLE "EmailClassificationLabel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"predictionId" uuid NOT NULL,
	"classification" text NOT NULL,
	"reason" text NOT NULL,
	"actorUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailClassificationLabel_classification_check" CHECK ("EmailClassificationLabel"."classification" IN ('related', 'unrelated', 'uncertain'))
);
--> statement-breakpoint
CREATE TABLE "EmailClassificationObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emailId" uuid NOT NULL,
	"runId" uuid,
	"checksum" text,
	"classification" text NOT NULL,
	"stage" text NOT NULL,
	"reason" text NOT NULL,
	"classificationVersion" text,
	"model" text,
	"usageId" uuid,
	"conflict" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailClassificationObservation_classification_check" CHECK ("EmailClassificationObservation"."classification" IN ('related', 'unrelated', 'uncertain')),
	CONSTRAINT "EmailClassificationObservation_stage_check" CHECK ("EmailClassificationObservation"."stage" IN ('rule', 'jev', 'model', 'resolution'))
);
--> statement-breakpoint
CREATE TABLE "EmailRetrievalFailure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emailId" uuid NOT NULL,
	"runId" uuid,
	"httpStatus" integer,
	"error" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailRetrievalFailure_httpStatus_check" CHECK ("EmailRetrievalFailure"."httpStatus" BETWEEN 100 AND 599)
);
--> statement-breakpoint
ALTER TABLE "RunFinding" DROP CONSTRAINT "RunFinding_entityKind_check";--> statement-breakpoint
ALTER TABLE "EmailClassificationLabel" ADD CONSTRAINT "EmailClassificationLabel_predictionId_EmailClassificationObservation_id_fk" FOREIGN KEY ("predictionId") REFERENCES "public"."EmailClassificationObservation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailClassificationLabel" ADD CONSTRAINT "EmailClassificationLabel_actorUserId_user_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_emailId_MailboxMessage_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."MailboxMessage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_usageId_AiUsage_id_fk" FOREIGN KEY ("usageId") REFERENCES "public"."AiUsage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailRetrievalFailure" ADD CONSTRAINT "EmailRetrievalFailure_emailId_MailboxMessage_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."MailboxMessage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailRetrievalFailure" ADD CONSTRAINT "EmailRetrievalFailure_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EmailClassificationLabel_prediction_idx" ON "EmailClassificationLabel" USING btree ("predictionId");--> statement-breakpoint
CREATE INDEX "EmailClassificationObservation_email_idx" ON "EmailClassificationObservation" USING btree ("emailId");--> statement-breakpoint
CREATE INDEX "EmailRetrievalFailure_email_idx" ON "EmailRetrievalFailure" USING btree ("emailId");--> statement-breakpoint
ALTER TABLE "RunFinding" ADD CONSTRAINT "RunFinding_entityKind_check" CHECK ("RunFinding"."entityKind" IN ('purchase', 'expense', 'product', 'run', 'email'));

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE TABLE "EmailCandidateObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"emailId" uuid NOT NULL,
	"runId" uuid,
	"preview" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "labelReviewedRevision" text;--> statement-breakpoint
ALTER TABLE "EmailCandidateObservation" ADD CONSTRAINT "EmailCandidateObservation_emailId_MailboxMessage_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."MailboxMessage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailCandidateObservation" ADD CONSTRAINT "EmailCandidateObservation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EmailCandidateObservation_email_idx" ON "EmailCandidateObservation" USING btree ("emailId");

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD COLUMN "promptVersion" text;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD COLUMN "operation" text;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_operation_check" CHECK ("EmailClassificationObservation"."operation" IN ('mailbox-triage', 'mailbox-relevance'));

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
CREATE TABLE "EmailAccuracyEvaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ownerUserId" text NOT NULL,
	"requestedSampleSize" integer NOT NULL,
	"populationCount" integer NOT NULL,
	"sampleSize" integer NOT NULL,
	"roster" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailAccuracyEvaluation_size_check" CHECK ("EmailAccuracyEvaluation"."requestedSampleSize" BETWEEN 1 AND 1000 AND "EmailAccuracyEvaluation"."populationCount" >= 0 AND "EmailAccuracyEvaluation"."sampleSize" BETWEEN 0 AND "EmailAccuracyEvaluation"."requestedSampleSize" AND "EmailAccuracyEvaluation"."sampleSize" <= "EmailAccuracyEvaluation"."populationCount")
);
--> statement-breakpoint
CREATE TABLE "EmailAccuracyGrade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evaluationId" uuid NOT NULL,
	"predictionId" uuid NOT NULL,
	"grade" text NOT NULL,
	"reason" text NOT NULL,
	"reviewedChecksum" text,
	"reviewedLabelId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EmailAccuracyGrade_value_check" CHECK ("EmailAccuracyGrade"."grade" IN ('related', 'unrelated', 'uncertain', 'unavailable')),
	CONSTRAINT "EmailAccuracyGrade_reason_check" CHECK (length(btrim("EmailAccuracyGrade"."reason")) > 0),
	CONSTRAINT "EmailAccuracyGrade_review_check" CHECK (("EmailAccuracyGrade"."grade" = 'unavailable' AND "EmailAccuracyGrade"."reviewedChecksum" IS NULL AND "EmailAccuracyGrade"."reviewedLabelId" IS NULL) OR ("EmailAccuracyGrade"."grade" <> 'unavailable' AND length("EmailAccuracyGrade"."reviewedChecksum") > 0 AND "EmailAccuracyGrade"."reviewedChecksum" IS NOT NULL AND "EmailAccuracyGrade"."reviewedLabelId" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "EmailAccuracyEvaluation" ADD CONSTRAINT "EmailAccuracyEvaluation_ownerUserId_user_id_fk" FOREIGN KEY ("ownerUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailAccuracyGrade" ADD CONSTRAINT "EmailAccuracyGrade_evaluationId_EmailAccuracyEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."EmailAccuracyEvaluation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailAccuracyGrade" ADD CONSTRAINT "EmailAccuracyGrade_predictionId_EmailClassificationObservation_id_fk" FOREIGN KEY ("predictionId") REFERENCES "public"."EmailClassificationObservation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailAccuracyGrade" ADD CONSTRAINT "EmailAccuracyGrade_reviewedLabelId_EmailClassificationLabel_id_fk" FOREIGN KEY ("reviewedLabelId") REFERENCES "public"."EmailClassificationLabel"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EmailAccuracyEvaluation_owner_idx" ON "EmailAccuracyEvaluation" USING btree ("ownerUserId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "EmailAccuracyGrade_evaluation_prediction_key" ON "EmailAccuracyGrade" USING btree ("evaluationId","predictionId");

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ALTER COLUMN "stage" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ALTER COLUMN "reason" DROP NOT NULL;
--> statement-breakpoint
-- BEGIN HISTORICAL EMAIL PREDICTIONS
INSERT INTO "EmailClassificationObservation"
  ("emailId", "runId", "checksum", "classification", "stage", "reason", "classificationVersion", "createdAt")
SELECT e.id, e."runId", e.checksum, e.classification, e."classificationStage",
       e."classificationReason", e."classificationVersion", e."updatedAt"
FROM "MailboxMessage" e
WHERE e.classification IS NOT NULL
  AND e."classificationStage" IS DISTINCT FROM 'resolution'
  AND NOT EXISTS (
    SELECT 1 FROM "EmailClassificationObservation" o
    WHERE o."emailId" = e.id
      AND o.checksum IS NOT DISTINCT FROM e.checksum
      AND o.classification = e.classification
      AND o.stage IS NOT DISTINCT FROM e."classificationStage"
      AND o.reason IS NOT DISTINCT FROM e."classificationReason"
      AND o."classificationVersion" IS NOT DISTINCT FROM e."classificationVersion"
  );
-- END HISTORICAL EMAIL PREDICTIONS

SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '120s';--> statement-breakpoint
-- Breaking cutover: every writer stays quiesced until the matching deployment.
-- Refuse to discard an unmigrated roster, outcome or progress identity.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "RunTarget" old WHERE old."entityKind" = 'image'
    AND NOT EXISTS (SELECT 1 FROM "PhotoRunImage" saved WHERE saved.id = old.id
      AND saved."runId" = old."runId" AND saved."imageId" = old."entityId"
      AND saved."workKey" = old."workKey")) THEN
    RAISE EXCEPTION 'Unmigrated photo Run target';
  END IF;
  IF EXISTS (SELECT 1 FROM "RunTarget" old WHERE old."entityKind" <> 'image'
    AND NOT EXISTS (SELECT 1 FROM "RunOperation" saved WHERE saved."runId" = old."runId"
      AND saved."operationId" = 'migrated-target:' || old.id::text
      AND saved.kind = 'target_outcome')) THEN
    RAISE EXCEPTION 'Unmigrated immutable Run outcome';
  END IF;
  IF EXISTS (SELECT 1 FROM "RunProgress" old JOIN "Run" saved ON saved.id = old."runId"
    WHERE NOT (COALESCE(saved."progressEventIds", '[]'::jsonb) ? old."eventId")) THEN
    RAISE EXCEPTION 'Unmigrated Run progress event identity';
  END IF;
  IF EXISTS (SELECT 1 FROM "OrderMail" original WHERE NOT EXISTS
    (SELECT 1 FROM "MailboxMessage" owner WHERE owner."orderMailId" = original.id
      AND owner."ledgerPartyId" = original."ledgerPartyId")) THEN
    RAISE EXCEPTION 'Retained original lacks its canonical Email owner';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "RunProgress";--> statement-breakpoint
DROP TABLE "RunTarget";--> statement-breakpoint
ALTER TABLE "VendorAccount" DROP COLUMN "browser";--> statement-breakpoint
ALTER TABLE "VendorAccount" DROP COLUMN "browserSyncEnabled";--> statement-breakpoint
ALTER TABLE "MailboxMessage" RENAME TO "Email";--> statement-breakpoint
ALTER TABLE "Email" RENAME CONSTRAINT "MailboxMessage_pkey" TO "Email_pkey";--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_executionPolicy_check";--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_searchOrigin_check";--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_classification_check";--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_classification_stage_check";--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_status_check";--> statement-breakpoint
ALTER TABLE "EmailCandidateObservation" DROP CONSTRAINT "EmailCandidateObservation_emailId_MailboxMessage_id_fk";
--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" DROP CONSTRAINT "EmailClassificationObservation_emailId_MailboxMessage_id_fk";
--> statement-breakpoint
ALTER TABLE "EmailRetrievalFailure" DROP CONSTRAINT "EmailRetrievalFailure_emailId_MailboxMessage_id_fk";
--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_ledgerPartyId_LedgerParty_id_fk";
--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_runId_Run_id_fk";
--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_orderMailId_OrderMail_id_fk";
--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "MailboxMessage_entity_identity_fk";
--> statement-breakpoint
DROP INDEX "MailboxMessage_shortcode_unique";--> statement-breakpoint
DROP INDEX "MailboxMessage_mailbox_message_key";--> statement-breakpoint
DROP INDEX "MailboxMessage_pending_idx";--> statement-breakpoint
DROP INDEX "MailboxMessage_orderMailId_key";--> statement-breakpoint
DROP INDEX "MailboxMessage_ledgerPartyId_receivedAt_idx";--> statement-breakpoint
DROP INDEX "MailboxMessage_runId_idx";--> statement-breakpoint
DROP INDEX "MailboxMessage_orderMailId_idx";--> statement-breakpoint
DROP INDEX "OrderMail_mailbox_message_key";--> statement-breakpoint
DROP INDEX "OrderMail_party_received_idx";--> statement-breakpoint
ALTER TABLE "EmailCandidateObservation" ADD CONSTRAINT "EmailCandidateObservation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."Email"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."Email"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EmailRetrievalFailure" ADD CONSTRAINT "EmailRetrievalFailure_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."Email"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_orderMailId_OrderMail_id_fk" FOREIGN KEY ("orderMailId") REFERENCES "public"."OrderMail"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "Email_shortcode_unique" ON "Email" USING btree ("shortcode");--> statement-breakpoint
CREATE UNIQUE INDEX "Email_mailbox_message_key" ON "Email" USING btree ("ledgerPartyId","provider","mailboxId","messageId");--> statement-breakpoint
CREATE INDEX "Email_pending_idx" ON "Email" USING btree ("ledgerPartyId","mailboxId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "Email_orderMailId_key" ON "Email" USING btree ("orderMailId") WHERE "Email"."orderMailId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "Email_ledgerPartyId_receivedAt_idx" ON "Email" USING btree ("ledgerPartyId","receivedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "Email_runId_idx" ON "Email" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "Email_orderMailId_idx" ON "Email" USING btree ("orderMailId");--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "mailboxId";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "messageId";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "threadId";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "historyId";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "sender";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "subject";--> statement-breakpoint
ALTER TABLE "OrderMail" DROP COLUMN "receivedAt";--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_executionPolicy_check" CHECK ("Email"."executionPolicy" IS NULL OR "Email"."executionPolicy" IN ('classification_only', 'import'));--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_searchOrigin_check" CHECK ("Email"."searchOrigin" IS NULL OR "Email"."searchOrigin" IN ('member_search', 'discovery'));--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_classification_check" CHECK ("classification" IN ('related', 'unrelated', 'uncertain'));--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_classification_stage_check" CHECK ("classificationStage" IS NULL OR "classificationStage" IN ('rule', 'jev', 'model', 'resolution'));--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_status_check" CHECK ("status" IN ('pending', 'researching', 'completed', 'blocked', 'deleted', 'excluded'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "entity_identity_on_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "Entity" ("id", "kind", "shortcode", "createdAt", "deletedAt")
  VALUES (NEW."id", TG_ARGV[0], NEW."shortcode", NEW."createdAt", NEW."deletedAt");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_soft_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity" SET "deletedAt" = NEW."deletedAt" WHERE "id" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "entity_identity_on_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Entity"
  SET "deletedAt" = COALESCE("deletedAt", OLD."deletedAt", now())
  WHERE "id" = OLD."id";
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('cookbook');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Cookbook"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Cookbook"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('device');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Device"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Device"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Email"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('email');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Email"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Email"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('expense');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Expense"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('financialAccount');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "FinancialAccount"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('financialTransaction');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "FinancialTransaction"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "FinancialTransaction"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('gardenEntry');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "GardenEntry"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "GardenEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Image"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('image');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Image"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Image"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ingredient');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Ingredient"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Ingredient"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('inventory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "InventoryEntry"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ledgerParty');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "LedgerParty"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "LedgerParty"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('ledgerTransfer');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "LedgerTransfer"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "LedgerTransfer"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('location');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Location"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('meal');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Meal"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Meal"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('plant');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Plant"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Plant"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('planting');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Planting"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Planting"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('product');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Product"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('productCategory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "ProductCategory"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('project');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Project"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('purchase');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Purchase"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('recipe');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Recipe"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Recipe"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('run');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Run"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Run"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "SpendingCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('spendingCategory');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "SpendingCategory"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "SpendingCategory"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('task');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Task"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Task"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('vendor');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Vendor"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "VendorAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('vendorAccount');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "VendorAccount"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "VendorAccount"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('wish');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "Wish"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "Wish"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_delete"();

CREATE OR REPLACE FUNCTION "entity_link_require_live_endpoints"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Entity"
    WHERE "id" IN (NEW."fromEntityId", NEW."toEntityId")
      AND "deletedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'EntityLink % (%) names a deleted entity: % -> %',
      NEW."id", NEW."kind", NEW."fromEntityId", NEW."toEntityId"
      USING ERRCODE = '23503', CONSTRAINT = 'EntityLink_live_endpoints_check';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
CREATE CONSTRAINT TRIGGER "EntityLink_live_endpoints" AFTER INSERT OR UPDATE ON "EntityLink"
  FOR EACH ROW WHEN (NEW."deletedAt" IS NULL)
  EXECUTE FUNCTION "entity_link_require_live_endpoints"();

CREATE OR REPLACE FUNCTION "Product_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."tags" IS DISTINCT FROM NEW."tags" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'tags'
      AND "status" = 'pending';
  END IF;
  IF OLD."categoryId" IS DISTINCT FROM NEW."categoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."ingredientId" IS DISTINCT FROM NEW."ingredientId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."growsPlantId" IS DISTINCT FROM NEW."growsPlantId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Product_supersede_suggestions_after_update" ON "Product";
CREATE TRIGGER "Product_supersede_suggestions_after_update" AFTER UPDATE OF "tags", "categoryId", "ingredientId", "growsPlantId" ON "Product" FOR EACH ROW EXECUTE FUNCTION "Product_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Location_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."type" IS DISTINCT FROM NEW."type" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Location_supersede_suggestions_after_update" ON "Location";
CREATE TRIGGER "Location_supersede_suggestions_after_update" AFTER UPDATE OF "type" ON "Location" FOR EACH ROW EXECUTE FUNCTION "Location_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "InventoryEntry_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."locationId" IS DISTINCT FROM NEW."locationId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'inventory'
      AND "recordId" = NEW."id"
      AND "field" = 'locationId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "InventoryEntry_supersede_suggestions_after_update" ON "InventoryEntry";
CREATE TRIGGER "InventoryEntry_supersede_suggestions_after_update" AFTER UPDATE OF "locationId" ON "InventoryEntry" FOR EACH ROW EXECUTE FUNCTION "InventoryEntry_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Meal_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."mealType" IS DISTINCT FROM NEW."mealType" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealType'
      AND "status" = 'pending';
  END IF;
  IF OLD."mealKind" IS DISTINCT FROM NEW."mealKind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealKind'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Meal_supersede_suggestions_after_update" ON "Meal";
CREATE TRIGGER "Meal_supersede_suggestions_after_update" AFTER UPDATE OF "mealType", "mealKind" ON "Meal" FOR EACH ROW EXECUTE FUNCTION "Meal_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Project_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultTrade" IS DISTINCT FROM NEW."defaultTrade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Project_supersede_suggestions_after_update" ON "Project";
CREATE TRIGGER "Project_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "kind", "defaultTrade" ON "Project" FOR EACH ROW EXECUTE FUNCTION "Project_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Task_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."subjectProductId" IS DISTINCT FROM NEW."subjectProductId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'subjectProductId'
      AND "status" = 'pending';
  END IF;
  IF OLD."trade" IS DISTINCT FROM NEW."trade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Task_supersede_suggestions_after_update" ON "Task";
CREATE TRIGGER "Task_supersede_suggestions_after_update" AFTER UPDATE OF "projectId", "subjectProductId", "trade" ON "Task" FOR EACH ROW EXECUTE FUNCTION "Task_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Vendor_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingProfile" IS DISTINCT FROM NEW."spendingProfile" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingProfile'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultSpendingCategoryId" IS DISTINCT FROM NEW."defaultSpendingCategoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Vendor_supersede_suggestions_after_update" ON "Vendor";
CREATE TRIGGER "Vendor_supersede_suggestions_after_update" AFTER UPDATE OF "spendingProfile", "defaultSpendingCategoryId", "evidenceExpectation" ON "Vendor" FOR EACH ROW EXECUTE FUNCTION "Vendor_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Purchase_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultProjectId" IS DISTINCT FROM NEW."defaultProjectId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultProjectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultTrade" IS DISTINCT FROM NEW."defaultTrade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'vendorId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Purchase_supersede_suggestions_after_update" ON "Purchase";
CREATE TRIGGER "Purchase_supersede_suggestions_after_update" AFTER UPDATE OF "spendingCategoryId", "evidenceExpectation", "defaultProjectId", "defaultTrade", "vendorId" ON "Purchase" FOR EACH ROW EXECUTE FUNCTION "Purchase_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "FinancialTransaction_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "FinancialTransaction_supersede_suggestions_after_update" ON "FinancialTransaction";
CREATE TRIGGER "FinancialTransaction_supersede_suggestions_after_update" AFTER UPDATE OF "evidenceExpectation" ON "FinancialTransaction" FOR EACH ROW EXECUTE FUNCTION "FinancialTransaction_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Expense_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."lineKind" IS DISTINCT FROM NEW."lineKind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'lineKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."costType" IS DISTINCT FROM NEW."costType" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'costType'
      AND "status" = 'pending';
  END IF;
  IF OLD."trade" IS DISTINCT FROM NEW."trade" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."purchaseId" IS DISTINCT FROM NEW."purchaseId" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'vendor'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Expense_supersede_suggestions_after_update" ON "Expense";
CREATE TRIGGER "Expense_supersede_suggestions_after_update" AFTER UPDATE OF "spendingCategoryId", "lineKind", "costType", "trade", "projectId", "productId", "purchaseId" ON "Expense" FOR EACH ROW EXECUTE FUNCTION "Expense_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Planting_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'planting'
      AND "recordId" = NEW."id"
      AND "field" = 'status'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Planting_supersede_suggestions_after_update" ON "Planting";
CREATE TRIGGER "Planting_supersede_suggestions_after_update" AFTER UPDATE OF "status" ON "Planting" FOR EACH ROW EXECUTE FUNCTION "Planting_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "GardenEntry_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'gardenEntry'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "GardenEntry_supersede_suggestions_after_update" ON "GardenEntry";
CREATE TRIGGER "GardenEntry_supersede_suggestions_after_update" AFTER UPDATE OF "kind" ON "GardenEntry" FOR EACH ROW EXECUTE FUNCTION "GardenEntry_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "ProductCategory_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."feature" IS DISTINCT FROM NEW."feature" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'feature'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "ProductCategory_supersede_suggestions_after_update" ON "ProductCategory";
CREATE TRIGGER "ProductCategory_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "feature" ON "ProductCategory" FOR EACH ROW EXECUTE FUNCTION "ProductCategory_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "SpendingCategory_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."evidenceExpectation" IS DISTINCT FROM NEW."evidenceExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'evidenceExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."productExpectation" IS DISTINCT FROM NEW."productExpectation" THEN
    UPDATE "Suggestion"
    SET "status" = 'superseded', "updatedAt" = now()
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'productExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "SpendingCategory_supersede_suggestions_after_update" ON "SpendingCategory";
CREATE TRIGGER "SpendingCategory_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "evidenceExpectation", "productExpectation" ON "SpendingCategory" FOR EACH ROW EXECUTE FUNCTION "SpendingCategory_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Purchase_supersede_expense_vendor_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "Suggestion" AS s SET "status" = 'superseded', "updatedAt" = now()
    FROM "Expense" AS r
    WHERE s."entity" = 'expense' AND s."field" = 'vendor'
      AND s."status" = 'pending' AND r."id" = s."recordId" AND r."purchaseId" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Purchase_supersede_expense_vendor_suggestions_after_update" ON "Purchase";
CREATE TRIGGER "Purchase_supersede_expense_vendor_suggestions_after_update" AFTER UPDATE OF "vendorId" ON "Purchase" FOR EACH ROW EXECUTE FUNCTION "Purchase_supersede_expense_vendor_suggestions_after_update"();

ALTER TABLE "Location" DROP CONSTRAINT IF EXISTS "Location_classification_type_productId_check";
ALTER TABLE "Location" ADD CONSTRAINT "Location_classification_type_productId_check" CHECK (("type" NOT IN ('furniture') OR "productId" IS NOT NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_productId_check" CHECK (("lineKind" NOT IN ('tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "productId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_spendingCategoryId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_spendingCategoryId_check" CHECK (("lineKind" NOT IN ('tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "spendingCategoryId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_projectId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_projectId_check" CHECK (("lineKind" NOT IN ('tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "projectId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineBasis_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineBasis_productId_check" CHECK (("lineBasis" NOT IN ('allocation') OR "productId" IS NULL));
--> statement-breakpoint
ALTER TABLE "OrderMailAttachment" ADD COLUMN "pendingDeleteKeys" text[] DEFAULT '{}'::text[] NOT NULL;
