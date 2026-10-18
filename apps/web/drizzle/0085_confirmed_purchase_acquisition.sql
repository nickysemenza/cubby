ALTER TABLE "EntityLink" ADD COLUMN "acquisitionConfirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_acquisition_confirmed_check" CHECK (NOT "EntityLink"."acquisitionConfirmed" OR "EntityLink"."kind" = 'purchaseProduct');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "Cookbook_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'cookbook'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'cookbook'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."author" IS DISTINCT FROM NEW."author" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'cookbook'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Cookbook_supersede_suggestions_after_update" ON "Cookbook";
CREATE TRIGGER "Cookbook_supersede_suggestions_after_update" AFTER UPDATE OF "productId", "name", "author" ON "Cookbook" FOR EACH ROW EXECUTE FUNCTION "Cookbook_supersede_suggestions_after_update"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "Device_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."productId" IS DISTINCT FROM NEW."productId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'device'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'device'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  IF OLD."platform" IS DISTINCT FROM NEW."platform" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'device'
      AND "recordId" = NEW."id"
      AND "field" = 'productId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Device_supersede_suggestions_after_update" ON "Device";
CREATE TRIGGER "Device_supersede_suggestions_after_update" AFTER UPDATE OF "productId", "name", "platform" ON "Device" FOR EACH ROW EXECUTE FUNCTION "Device_supersede_suggestions_after_update"();
