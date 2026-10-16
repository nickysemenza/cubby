CREATE OR REPLACE FUNCTION "FinancialAccount_supersede_suggestions_after_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'issuer'
      AND "status" = 'pending';
  END IF;
  IF OLD."identity" IS DISTINCT FROM NEW."identity" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'issuer'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'issuer'
      AND "status" = 'pending';
  END IF;
  IF OLD."sourceAliases" IS DISTINCT FROM NEW."sourceAliases" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'issuer'
      AND "status" = 'pending';
  END IF;
  IF OLD."identity" IS DISTINCT FROM NEW."identity" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'issuer'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'network'
      AND "status" = 'pending';
  END IF;
  IF OLD."identity" IS DISTINCT FROM NEW."identity" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'network'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'network'
      AND "status" = 'pending';
  END IF;
  IF OLD."sourceAliases" IS DISTINCT FROM NEW."sourceAliases" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'network'
      AND "status" = 'pending';
  END IF;
  IF OLD."identity" IS DISTINCT FROM NEW."identity" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'network'
      AND "status" = 'pending';
  END IF;
  IF OLD."primaryCardholderId" IS DISTINCT FROM NEW."primaryCardholderId" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'target_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'primaryCardholderId'
      AND "status" = 'pending';
  END IF;
  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'primaryCardholderId'
      AND "status" = 'pending';
  END IF;
  IF OLD."identity" IS DISTINCT FROM NEW."identity" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'primaryCardholderId'
      AND "status" = 'pending';
  END IF;
  IF OLD."notes" IS DISTINCT FROM NEW."notes" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'primaryCardholderId'
      AND "status" = 'pending';
  END IF;
  IF OLD."authorizedUsers" IS DISTINCT FROM NEW."authorizedUsers" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'primaryCardholderId'
      AND "status" = 'pending';
  END IF;
  IF OLD."fundingPeriods" IS DISTINCT FROM NEW."fundingPeriods" THEN
    UPDATE "AssessmentState"
    SET "status" = 'superseded', "updatedAt" = now(),
        "supersessionReceipt" = jsonb_build_object('reason', 'input_changed', 'evaluationId', NULL, 'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE "entity" = 'financialAccount'
      AND "recordId" = NEW."id"
      AND "field" = 'primaryCardholderId'
      AND "status" = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "FinancialAccount_supersede_suggestions_after_update" ON "FinancialAccount";
CREATE TRIGGER "FinancialAccount_supersede_suggestions_after_update" AFTER UPDATE OF "name", "identity", "notes", "sourceAliases", "primaryCardholderId", "authorizedUsers", "fundingPeriods" ON "FinancialAccount" FOR EACH ROW EXECUTE FUNCTION "FinancialAccount_supersede_suggestions_after_update"();
