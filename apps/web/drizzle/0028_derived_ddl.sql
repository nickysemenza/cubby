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

ALTER TABLE "Location" DROP CONSTRAINT IF EXISTS "Location_classification_type_productId_check";
ALTER TABLE "Location" ADD CONSTRAINT "Location_classification_type_productId_check" CHECK ("type" NOT IN ('furniture') OR "productId" IS NOT NULL) NOT VALID;
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_productId_check" CHECK ("lineKind" NOT IN ('principal') OR "productId" IS NULL) NOT VALID;
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_spendingCategoryId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_spendingCategoryId_check" CHECK ("lineKind" NOT IN ('principal') OR "spendingCategoryId" IS NULL) NOT VALID;
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_projectId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_projectId_check" CHECK ("lineKind" NOT IN ('principal') OR "projectId" IS NULL) NOT VALID;
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineBasis_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineBasis_productId_check" CHECK ("lineBasis" NOT IN ('allocation') OR "productId" IS NULL) NOT VALID;
