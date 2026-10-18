CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_statement_charge_key" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey')) WHERE family='statement_transaction' AND active;
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_refs_idx" ON "AssessmentState" USING gin ((data->'refs')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_account_idx" ON "AssessmentState" ((data->>'accountId'),(data->>'month')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "StatementRow_source_charge_idx" ON "StatementRow" (source,(COALESCE("legacyExternalId","externalId"))) WHERE "deletedAt" IS NULL;

CREATE OR REPLACE FUNCTION "retire_statement_suggestions"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='EntityExternalId' THEN
  IF NEW.kind<>'settlement_ref' OR NEW."deletedAt" IS NOT NULL THEN RETURN NULL; END IF;
 ELSIF NOT (NEW."deletedAt" IS NOT NULL OR NEW.disposition='ignored' OR NEW."supersededByRowId" IS NOT NULL) THEN
  RETURN NULL;
 END IF;
 UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now()
 WHERE family='statement_transaction' AND active AND status='pending' AND data->'refs' ? (NEW.source||':'||NEW."externalId");
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "EntityExternalId_retire_statement_suggestions" ON "EntityExternalId";
CREATE TRIGGER "EntityExternalId_retire_statement_suggestions" AFTER INSERT OR UPDATE OF "deletedAt","externalId",kind ON "EntityExternalId" FOR EACH ROW EXECUTE FUNCTION "retire_statement_suggestions"();
DROP TRIGGER IF EXISTS "StatementRow_retire_statement_suggestions" ON "StatementRow";
CREATE TRIGGER "StatementRow_retire_statement_suggestions" AFTER UPDATE OF "deletedAt",disposition,"supersededByRowId" ON "StatementRow" FOR EACH ROW EXECUTE FUNCTION "retire_statement_suggestions"();
