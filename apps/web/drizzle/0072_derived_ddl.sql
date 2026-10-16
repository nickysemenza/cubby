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

CREATE OR REPLACE TRIGGER "Entity_identity_insert" AFTER INSERT ON "ImageProcessingJob"
  FOR EACH ROW EXECUTE FUNCTION "entity_identity_on_insert"('imageJob');
CREATE OR REPLACE TRIGGER "Entity_identity_soft_delete" AFTER UPDATE OF "deletedAt" ON "ImageProcessingJob"
  FOR EACH ROW WHEN (OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt")
  EXECUTE FUNCTION "entity_identity_on_soft_delete"();
CREATE OR REPLACE TRIGGER "Entity_identity_delete" AFTER DELETE ON "ImageProcessingJob"
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
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'tags'
      AND "status" = 'pending';
  END IF;
  IF OLD."manufacturer" IS DISTINCT FROM NEW."manufacturer" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'tags'
      AND "status" = 'pending';
  END IF;
  IF OLD."categoryId" IS DISTINCT FROM NEW."categoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'tags'
      AND "status" = 'pending';
  END IF;
  IF OLD."aliases" IS DISTINCT FROM NEW."aliases" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'tags'
      AND "status" = 'pending';
  END IF;
  IF OLD."categoryId" IS DISTINCT FROM NEW."categoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."manufacturer" IS DISTINCT FROM NEW."manufacturer" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."model" IS DISTINCT FROM NEW."model" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'categoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."ingredientId" IS DISTINCT FROM NEW."ingredientId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."manufacturer" IS DISTINCT FROM NEW."manufacturer" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."categoryId" IS DISTINCT FROM NEW."categoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'ingredientId'
      AND "status" = 'pending';
  END IF;
  IF OLD."growsPlantId" IS DISTINCT FROM NEW."growsPlantId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  IF OLD."manufacturer" IS DISTINCT FROM NEW."manufacturer" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  IF OLD."categoryId" IS DISTINCT FROM NEW."categoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'product'
      AND "recordId" = NEW."id"
      AND "field" = 'growsPlantId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Product_supersede_suggestions_after_update" ON "Product";
CREATE TRIGGER "Product_supersede_suggestions_after_update" AFTER UPDATE OF "tags", "manufacturer", "categoryId", "aliases", "name", "model", "notes", "ingredientId", "growsPlantId" ON "Product" FOR EACH ROW EXECUTE FUNCTION "Product_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Location_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."type" IS DISTINCT FROM NEW."type" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'location'
      AND "recordId" = NEW."id"
      AND "field" = 'type'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Location_supersede_suggestions_after_update" ON "Location";
CREATE TRIGGER "Location_supersede_suggestions_after_update" AFTER UPDATE OF "type", "name", "notes", "parentId", "productId" ON "Location" FOR EACH ROW EXECUTE FUNCTION "Location_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "InventoryEntry_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."locationId" IS DISTINCT FROM NEW."locationId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'inventory'
      AND "recordId" = NEW."id"
      AND "field" = 'locationId'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'inventory'
      AND "recordId" = NEW."id"
      AND "field" = 'locationId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "InventoryEntry_supersede_suggestions_after_update" ON "InventoryEntry";
CREATE TRIGGER "InventoryEntry_supersede_suggestions_after_update" AFTER UPDATE OF "locationId", "productId" ON "InventoryEntry" FOR EACH ROW EXECUTE FUNCTION "InventoryEntry_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Meal_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."mealType" IS DISTINCT FROM NEW."mealType" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealType'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealType'
      AND "status" = 'pending';
  END IF;
  IF OLD."mealKind" IS DISTINCT FROM NEW."mealKind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'meal'
      AND "recordId" = NEW."id"
      AND "field" = 'mealKind'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Meal_supersede_suggestions_after_update" ON "Meal";
CREATE TRIGGER "Meal_supersede_suggestions_after_update" AFTER UPDATE OF "mealType", "name", "mealKind" ON "Meal" FOR EACH ROW EXECUTE FUNCTION "Meal_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Project_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultTrade" IS DISTINCT FROM NEW."defaultTrade" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'project'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Project_supersede_suggestions_after_update" ON "Project";
CREATE TRIGGER "Project_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "name", "notes", "kind", "defaultTrade" ON "Project" FOR EACH ROW EXECUTE FUNCTION "Project_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Task_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."subjectProductId" IS DISTINCT FROM NEW."subjectProductId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'subjectProductId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'subjectProductId'
      AND "status" = 'pending';
  END IF;
  IF OLD."trade" IS DISTINCT FROM NEW."trade" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'task'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Task_supersede_suggestions_after_update" ON "Task";
CREATE TRIGGER "Task_supersede_suggestions_after_update" AFTER UPDATE OF "projectId", "name", "subjectProductId", "trade" ON "Task" FOR EACH ROW EXECUTE FUNCTION "Task_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Vendor_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingProfile" IS DISTINCT FROM NEW."spendingProfile" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingProfile'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingProfile'
      AND "status" = 'pending';
  END IF;
  IF OLD."website" IS DISTINCT FROM NEW."website" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingProfile'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingProfile'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultSpendingCategoryId" IS DISTINCT FROM NEW."defaultSpendingCategoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."website" IS DISTINCT FROM NEW."website" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."spendingProfile" IS DISTINCT FROM NEW."spendingProfile" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultSpendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."itemizationExpectation" IS DISTINCT FROM NEW."itemizationExpectation" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."website" IS DISTINCT FROM NEW."website" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'vendor'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Vendor_supersede_suggestions_after_update" ON "Vendor";
CREATE TRIGGER "Vendor_supersede_suggestions_after_update" AFTER UPDATE OF "spendingProfile", "name", "website", "notes", "defaultSpendingCategoryId", "itemizationExpectation" ON "Vendor" FOR EACH ROW EXECUTE FUNCTION "Vendor_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Purchase_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."displayLabel" IS DISTINCT FROM NEW."displayLabel" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."itemizationExpectation" IS DISTINCT FROM NEW."itemizationExpectation" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."displayLabel" IS DISTINCT FROM NEW."displayLabel" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultProjectId" IS DISTINCT FROM NEW."defaultProjectId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultProjectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."displayLabel" IS DISTINCT FROM NEW."displayLabel" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultProjectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultProjectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultProjectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."defaultTrade" IS DISTINCT FROM NEW."defaultTrade" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."displayLabel" IS DISTINCT FROM NEW."displayLabel" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'defaultTrade'
      AND "status" = 'pending';
  END IF;
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'vendorId'
      AND "status" = 'pending';
  END IF;
  IF OLD."displayLabel" IS DISTINCT FROM NEW."displayLabel" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'vendorId'
      AND "status" = 'pending';
  END IF;
  IF OLD."orderId" IS DISTINCT FROM NEW."orderId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'vendorId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'purchase'
      AND "recordId" = NEW."id"
      AND "field" = 'vendorId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Purchase_supersede_suggestions_after_update" ON "Purchase";
CREATE TRIGGER "Purchase_supersede_suggestions_after_update" AFTER UPDATE OF "spendingCategoryId", "displayLabel", "vendorId", "notes", "itemizationExpectation", "defaultProjectId", "defaultTrade", "orderId" ON "Purchase" FOR EACH ROW EXECUTE FUNCTION "Purchase_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "FinancialTransaction_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."itemizationExpectation" IS DISTINCT FROM NEW."itemizationExpectation" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."merchant" IS DISTINCT FROM NEW."merchant" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."rawDescription" IS DISTINCT FROM NEW."rawDescription" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."sourceCategory" IS DISTINCT FROM NEW."sourceCategory" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialTransaction'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "FinancialTransaction_supersede_suggestions_after_update" ON "FinancialTransaction";
CREATE TRIGGER "FinancialTransaction_supersede_suggestions_after_update" AFTER UPDATE OF "itemizationExpectation", "spendingCategoryId", "merchant", "rawDescription", "sourceCategory", "kind", "notes" ON "FinancialTransaction" FOR EACH ROW EXECUTE FUNCTION "FinancialTransaction_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Expense_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."spendingCategoryId" IS DISTINCT FROM NEW."spendingCategoryId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."lineKind" IS DISTINCT FROM NEW."lineKind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'spendingCategoryId'
      AND "status" = 'pending';
  END IF;
  IF OLD."lineKind" IS DISTINCT FROM NEW."lineKind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'lineKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'lineKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."cost" IS DISTINCT FROM NEW."cost" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'lineKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'lineKind'
      AND "status" = 'pending';
  END IF;
  IF OLD."costType" IS DISTINCT FROM NEW."costType" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'costType'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'costType'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'costType'
      AND "status" = 'pending';
  END IF;
  IF OLD."trade" IS DISTINCT FROM NEW."trade" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'trade'
      AND "status" = 'pending';
  END IF;
  IF OLD."projectId" IS DISTINCT FROM NEW."projectId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."date" IS DISTINCT FROM NEW."date" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'projectId'
      AND "status" = 'pending';
  END IF;
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'vendor'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'vendor'
      AND "status" = 'pending';
  END IF;
  IF OLD."purchaseId" IS DISTINCT FROM NEW."purchaseId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'expense'
      AND "recordId" = NEW."id"
      AND "field" = 'vendor'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Expense_supersede_suggestions_after_update" ON "Expense";
CREATE TRIGGER "Expense_supersede_suggestions_after_update" AFTER UPDATE OF "spendingCategoryId", "name", "productId", "notes", "lineKind", "cost", "costType", "trade", "projectId", "date", "purchaseId" ON "Expense" FOR EACH ROW EXECUTE FUNCTION "Expense_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Planting_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'planting'
      AND "recordId" = NEW."id"
      AND "field" = 'status'
      AND "status" = 'pending';
  END IF;
  IF OLD."transplantedOn" IS DISTINCT FROM NEW."transplantedOn" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'planting'
      AND "recordId" = NEW."id"
      AND "field" = 'status'
      AND "status" = 'pending';
  END IF;
  IF OLD."finishedOn" IS DISTINCT FROM NEW."finishedOn" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'planting'
      AND "recordId" = NEW."id"
      AND "field" = 'status'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Planting_supersede_suggestions_after_update" ON "Planting";
CREATE TRIGGER "Planting_supersede_suggestions_after_update" AFTER UPDATE OF "status", "transplantedOn", "finishedOn" ON "Planting" FOR EACH ROW EXECUTE FUNCTION "Planting_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "GardenEntry_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'gardenEntry'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."harvestAmount" IS DISTINCT FROM NEW."harvestAmount" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'gardenEntry'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'gardenEntry'
      AND "recordId" = NEW."id"
      AND "field" = 'kind'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "GardenEntry_supersede_suggestions_after_update" ON "GardenEntry";
CREATE TRIGGER "GardenEntry_supersede_suggestions_after_update" AFTER UPDATE OF "kind", "harvestAmount", "notes" ON "GardenEntry" FOR EACH ROW EXECUTE FUNCTION "GardenEntry_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "ProductCategory_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."description" IS DISTINCT FROM NEW."description" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."feature" IS DISTINCT FROM NEW."feature" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'feature'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'feature'
      AND "status" = 'pending';
  END IF;
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'productCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'feature'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "ProductCategory_supersede_suggestions_after_update" ON "ProductCategory";
CREATE TRIGGER "ProductCategory_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "name", "description", "parentId", "feature" ON "ProductCategory" FOR EACH ROW EXECUTE FUNCTION "ProductCategory_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "SpendingCategory_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."emoji" IS DISTINCT FROM NEW."emoji" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'emoji'
      AND "status" = 'pending';
  END IF;
  IF OLD."itemizationExpectation" IS DISTINCT FROM NEW."itemizationExpectation" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'itemizationExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."productExpectation" IS DISTINCT FROM NEW."productExpectation" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'productExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'productExpectation'
      AND "status" = 'pending';
  END IF;
  IF OLD."parentId" IS DISTINCT FROM NEW."parentId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'spendingCategory'
      AND "recordId" = NEW."id"
      AND "field" = 'productExpectation'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "SpendingCategory_supersede_suggestions_after_update" ON "SpendingCategory";
CREATE TRIGGER "SpendingCategory_supersede_suggestions_after_update" AFTER UPDATE OF "emoji", "name", "parentId", "itemizationExpectation", "productExpectation" ON "SpendingCategory" FOR EACH ROW EXECUTE FUNCTION "SpendingCategory_supersede_suggestions_after_update"();

CREATE OR REPLACE FUNCTION "Purchase_supersede_expense_vendor_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."vendorId" IS DISTINCT FROM NEW."vendorId" THEN
    UPDATE "AssessmentState" AS s SET "status" = 'superseded', "updatedAt" = now(), "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_productId_check" CHECK (("lineKind" NOT IN ('unclassified', 'tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "productId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_spendingCategoryId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_spendingCategoryId_check" CHECK (("lineKind" NOT IN ('unclassified', 'tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "spendingCategoryId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineKind_projectId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineKind_projectId_check" CHECK (("lineKind" NOT IN ('unclassified', 'tax', 'shipping', 'discount', 'fee', 'tip', 'other_adjustment') OR "projectId" IS NULL));
ALTER TABLE "Expense" DROP CONSTRAINT IF EXISTS "Expense_classification_lineBasis_productId_check";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_classification_lineBasis_productId_check" CHECK (("lineBasis" NOT IN ('allocation') OR "productId" IS NULL));


CREATE OR REPLACE VIEW "AssessmentEmailLink" AS
SELECT id,(data->>'eventId')::uuid AS "eventId",(data->>'purchaseId')::uuid AS "purchaseId",
 data->>'decision' AS decision,data->>'evidenceChecksum' AS "evidenceChecksum",data->>'decidedByUserId' AS "decidedByUserId",data->>'proposedBy' AS "proposedBy","createdAt","updatedAt"
FROM "AssessmentState" WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_event_purchase_key" ON "AssessmentState" ((data->>'eventId'),(data->>'purchaseId')) WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_one_link_key" ON "AssessmentState" ((data->>'eventId')) WHERE family='email_link' AND active AND data->>'decision'='linked';
-- Match linked association reads: both the UUID key and linked predicate keep
-- the planner from choosing an unselective scan of the text uniqueness key.
CREATE INDEX IF NOT EXISTS "AssessmentState_email_linked_event_uuid_idx" ON "AssessmentState" (((data->>'eventId')::uuid)) WHERE family='email_link' AND active AND data->>'decision'='linked';

-- Operational mail authority follows retained events, independently of Email lifecycle.
CREATE OR REPLACE FUNCTION "assessment_mail_lifecycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Email' THEN
  IF TG_OP='DELETE' OR NEW."deletedAt" IS NOT NULL THEN
   UPDATE "AssessmentState" SET entity='orderMailEvent',"recordId"=(data->>'eventId')::uuid,"updatedAt"=now() WHERE family='email_link' AND entity='email' AND "recordId"=OLD.id;
   UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now() WHERE entity='email' AND "recordId"=OLD.id;
  END IF;
 ELSE
  IF TG_OP='DELETE' OR NEW."supersededAt" IS NOT NULL THEN
   UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now() WHERE family='email_link' AND data->>'eventId'=OLD.id::text;
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "Email_assessment_lifecycle" ON "Email";
CREATE TRIGGER "Email_assessment_lifecycle" AFTER DELETE OR UPDATE OF "deletedAt" ON "Email" FOR EACH ROW EXECUTE FUNCTION "assessment_mail_lifecycle"();
DROP TRIGGER IF EXISTS "OrderMailEvent_assessment_lifecycle" ON "OrderMailEvent";
CREATE TRIGGER "OrderMailEvent_assessment_lifecycle" AFTER DELETE OR UPDATE OF "supersededAt" ON "OrderMailEvent" FOR EACH ROW EXECUTE FUNCTION "assessment_mail_lifecycle"();

CREATE OR REPLACE FUNCTION "assessment_history_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% history is immutable', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS "Assessment_immutable" ON "Assessment";
CREATE TRIGGER "Assessment_immutable" BEFORE UPDATE OR DELETE ON "Assessment" FOR EACH ROW EXECUTE FUNCTION "assessment_history_immutable"();
DROP TRIGGER IF EXISTS "Feedback_immutable" ON "Feedback";
CREATE TRIGGER "Feedback_immutable" BEFORE UPDATE OR DELETE ON "Feedback" FOR EACH ROW EXECUTE FUNCTION "assessment_history_immutable"();
CREATE OR REPLACE FUNCTION "publish_field_assessment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family = 'field' AND NOT EXISTS (SELECT 1 FROM "Assessment" WHERE id = NEW.id) THEN
    INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, producer, evidence, served, "createdAt")
    VALUES (NEW.id, 'field:' || NEW.id::text, 'field',
      jsonb_build_object('kind','field','entity',NEW.entity,'recordId',NEW."recordId",'field',NEW.field,'draft',false),
      jsonb_build_object('value',NEW."suggestedValue",'confidence',NEW.confidence,'runnerUpValue',NEW."runnerUpValue",'runnerUpConfidence',NEW."runnerUpConfidence",'kind',NEW.kind),
      COALESCE(NEW.provenance->>'inputFingerprint',NEW."financeReviewFingerprint"),
      CASE WHEN NEW.model = 'unknown' THEN NULL ELSE jsonb_build_object('kind','model','model',NEW.model,'revision',NULL,'runId',NEW."runId",'evaluationId',NEW."evaluationId") END,
      jsonb_build_object('currentValue',NEW."currentValue",'provenance',NEW.provenance),
      NEW."pairKey" IS NULL OR EXISTS(SELECT 1 FROM "Run" r WHERE r.id=NEW."runId" AND r."deletedAt" IS NULL AND r.input->>'decisionModel'=NEW.model), NEW."createdAt");
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "AssessmentState_publish_field" ON "AssessmentState";
CREATE TRIGGER "AssessmentState_publish_field" BEFORE INSERT ON "AssessmentState" FOR EACH ROW EXECUTE FUNCTION "publish_field_assessment"();



CREATE OR REPLACE FUNCTION "retire_product_pair_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE targets uuid[] := '{}'; image_id uuid;
BEGIN
 IF TG_TABLE_NAME='Product' THEN targets=ARRAY[NEW.id];
 ELSIF TG_TABLE_NAME IN ('EntityAttachment','EntitySource','EntityExternalId') THEN
  IF TG_OP<>'INSERT' AND OLD."entityKind"='product' THEN targets=array_append(targets,OLD."entityId"); END IF;
  IF TG_OP<>'DELETE' AND NEW."entityKind"='product' THEN targets=array_append(targets,NEW."entityId"); END IF;
 ELSIF TG_TABLE_NAME='ImportSourceProduct' THEN
  IF TG_OP<>'INSERT' THEN targets=array_append(targets,OLD."productId"); END IF;
  IF TG_OP<>'DELETE' THEN targets=array_append(targets,NEW."productId"); END IF;
 ELSIF TG_TABLE_NAME='ImportSourceOrder' THEN
  SELECT array_agg("productId") INTO targets FROM "ImportSourceProduct" WHERE "sourceOrderId"=NEW.id;
 ELSIF TG_TABLE_NAME='Image' THEN image_id=NEW.id;
 ELSIF TG_TABLE_NAME='AssessmentState' THEN
  IF NEW.family='image_description' THEN image_id=NEW."recordId"; END IF;
 ELSIF TG_TABLE_NAME='AiAnalysis' THEN
  IF NEW."entityKind"='image' AND NEW.feature='image-description' THEN image_id=NEW."entityId"; END IF;
 END IF;
 IF image_id IS NOT NULL THEN
  SELECT array_agg("entityId") INTO targets FROM "EntityAttachment" WHERE "imageId"=image_id AND "entityKind"='product' AND "deletedAt" IS NULL;
 END IF;
 IF cardinality(targets)>0 THEN
  UPDATE "AssessmentState" SET status='superseded',"updatedAt"=now() WHERE family='product_pair' AND active AND ("recordId"=ANY(targets) OR (data->>'otherId')::uuid=ANY(targets));
  IF TG_TABLE_NAME<>'Product' THEN
   UPDATE "AssessmentState" SET status='superseded',"updatedAt"=now(),"supersessionReceipt"=jsonb_build_object('reason','input_changed','evaluationId',NULL,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE family='field' AND entity='product' AND active AND status='pending' AND "recordId"=ANY(targets) AND field IN ('categoryId');
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "Product_retire_identity_pairs" ON "Product";
CREATE TRIGGER "Product_retire_identity_pairs" AFTER UPDATE OF name,manufacturer,model,aliases,"deletedAt" ON "Product" FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.manufacturer IS DISTINCT FROM NEW.manufacturer OR OLD.model IS DISTINCT FROM NEW.model OR OLD.aliases IS DISTINCT FROM NEW.aliases OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt") EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "EntityAttachment_retire_identity_pairs" ON "EntityAttachment";
CREATE TRIGGER "EntityAttachment_retire_identity_pairs" AFTER INSERT OR UPDATE OR DELETE ON "EntityAttachment" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "EntitySource_retire_identity_pairs" ON "EntitySource";
CREATE TRIGGER "EntitySource_retire_identity_pairs" AFTER INSERT OR UPDATE OR DELETE ON "EntitySource" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "EntityExternalId_retire_identity_pairs" ON "EntityExternalId";
CREATE TRIGGER "EntityExternalId_retire_identity_pairs" AFTER INSERT OR UPDATE OR DELETE ON "EntityExternalId" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "ImportSourceProduct_retire_identity_pairs" ON "ImportSourceProduct";
CREATE TRIGGER "ImportSourceProduct_retire_identity_pairs" AFTER INSERT OR UPDATE OR DELETE ON "ImportSourceProduct" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "ImportSourceOrder_retire_identity_pairs" ON "ImportSourceOrder";
CREATE TRIGGER "ImportSourceOrder_retire_identity_pairs" AFTER UPDATE ON "ImportSourceOrder" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "Image_retire_identity_pairs" ON "Image";
CREATE TRIGGER "Image_retire_identity_pairs" AFTER UPDATE OF sha256,"deletedAt" ON "Image" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "AssessmentState_retire_image_identity_pairs" ON "AssessmentState";
CREATE TRIGGER "AssessmentState_retire_image_identity_pairs" AFTER UPDATE OF "confirmedValue",active ON "AssessmentState" FOR EACH ROW WHEN (OLD."confirmedValue" IS DISTINCT FROM NEW."confirmedValue" OR OLD.active IS DISTINCT FROM NEW.active) EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "AiAnalysis_retire_image_identity_pairs" ON "AiAnalysis";
CREATE TRIGGER "AiAnalysis_retire_image_identity_pairs" AFTER INSERT OR UPDATE ON "AiAnalysis" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();

