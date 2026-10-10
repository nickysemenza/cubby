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
