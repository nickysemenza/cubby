CREATE TABLE "SpendingCategory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"parentId" uuid,
	"evidenceExpectation" text DEFAULT 'unknown' NOT NULL,
	"productExpectation" text DEFAULT 'unknown' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "SpendingCategory_evidenceExpectation_check" CHECK ("SpendingCategory"."evidenceExpectation" IN ('unknown', 'required', 'not_expected')),
	CONSTRAINT "SpendingCategory_productExpectation_check" CHECK ("SpendingCategory"."productExpectation" IN ('unknown', 'required', 'not_expected'))
);
--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";--> statement-breakpoint
ALTER TABLE "StatementRow" DROP CONSTRAINT "StatementRow_amount_whole_cent_check";--> statement-breakpoint
ALTER TABLE "StatementRow" DROP CONSTRAINT "StatementRow_providerAmount_whole_cent_check";--> statement-breakpoint
ALTER TABLE "StatementRow" DROP CONSTRAINT "StatementRow_externalId_format_check";--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "rowPosition" integer;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "providerTransactionId" text;--> statement-breakpoint
ALTER TABLE "StatementRow" ADD COLUMN "legacyExternalId" text;--> statement-breakpoint
ALTER TABLE "Expense" ADD COLUMN "spendingCategoryId" uuid;--> statement-breakpoint
ALTER TABLE "Expense" ADD COLUMN "economicRole" text DEFAULT 'vendor' NOT NULL;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD COLUMN "spendingCategoryId" uuid;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD COLUMN "evidenceExpectation" text;--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN "acquisitionOrigin" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "spendingCategoryId" uuid;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "evidenceExpectation" text;--> statement-breakpoint
ALTER TABLE "Purchase" ADD COLUMN "itemizationEvidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Vendor" ADD COLUMN "evidenceExpectation" text;--> statement-breakpoint
ALTER TABLE "SpendingCategory" ADD CONSTRAINT "SpendingCategory_parentId_SpendingCategory_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."SpendingCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SpendingCategory" ADD CONSTRAINT "SpendingCategory_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "SpendingCategory_shortcode_unique" ON "SpendingCategory" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "SpendingCategory_parentId_idx" ON "SpendingCategory" USING btree ("parentId");--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES "public"."SpendingCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES "public"."SpendingCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES "public"."SpendingCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "StatementRow_batch_position_key" ON "StatementRow" USING btree ("batchId","rowPosition") WHERE "StatementRow"."deletedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "StatementRow_source_providerTransactionId_idx" ON "StatementRow" USING btree ("source","providerTransactionId");--> statement-breakpoint
CREATE INDEX "Expense_spendingCategoryId_idx" ON "Expense" USING btree ("spendingCategoryId");--> statement-breakpoint
CREATE INDEX "FinancialTransaction_spendingCategoryId_idx" ON "FinancialTransaction" USING btree ("spendingCategoryId");--> statement-breakpoint
CREATE INDEX "Purchase_spendingCategoryId_idx" ON "Purchase" USING btree ("spendingCategoryId");--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory'));--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' ELSE false END);--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_position_check" CHECK ("StatementRow"."rowPosition" IS NULL OR "StatementRow"."rowPosition" > 0);--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_amount_whole_cent_check" CHECK (abs("StatementRow"."amount" * 100 - round("StatementRow"."amount" * 100)) < 0.0000001);--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_providerAmount_whole_cent_check" CHECK (abs("StatementRow"."providerAmount" * 100 - round("StatementRow"."providerAmount" * 100)) < 0.0000001);--> statement-breakpoint
ALTER TABLE "StatementRow" ADD CONSTRAINT "StatementRow_externalId_format_check" CHECK ("StatementRow"."externalId" ~ '^v[12]:[0-9a-f]{64}$');
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
--> statement-breakpoint
ALTER TABLE "Expense" ADD COLUMN "bookingTransactionCode" text;
--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD COLUMN "targetPurchaseId" uuid;--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD COLUMN "bookingDecisionFingerprint" text;--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD CONSTRAINT "ImportPreparedOrder_targetPurchaseId_Purchase_id_fk" FOREIGN KEY ("targetPurchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "Vendor" SET "evidenceExpectation" = CASE "orderEvidence"
  WHEN 'online_account' THEN 'required'
  WHEN 'receipt_only' THEN 'required'
  WHEN 'not_expected' THEN 'not_expected'
END WHERE "evidenceExpectation" IS NULL AND "orderEvidence" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD COLUMN "bookingExpenseFingerprint" text;
--> statement-breakpoint
ALTER TABLE "FinancialTransaction" ADD COLUMN "bookingCorrectionReceipt" jsonb;
