/** Histories are append-only even for SQL writers; projection inserts publish field evidence atomically. */
export const assessmentHistoryDdl = () => `
CREATE OR REPLACE VIEW "AssessmentEmailLink" AS
SELECT id,(data->>'eventId')::uuid AS "eventId",(data->>'purchaseId')::uuid AS "purchaseId",
 data->>'decision' AS decision,data->>'evidenceChecksum' AS "evidenceChecksum",data->>'decidedByUserId' AS "decidedByUserId",data->>'proposedBy' AS "proposedBy","createdAt","updatedAt"
FROM "AssessmentState" WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_event_purchase_key" ON "AssessmentState" ((data->>'eventId'),(data->>'purchaseId')) WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_one_link_key" ON "AssessmentState" ((data->>'eventId')) WHERE family='email_link' AND active AND data->>'decision'='linked';
-- Match linked association reads: both the UUID key and linked predicate keep
-- the planner from choosing an unselective scan of the text uniqueness key.
CREATE INDEX IF NOT EXISTS "AssessmentState_email_linked_event_uuid_idx" ON "AssessmentState" (((data->>'eventId')::uuid)) WHERE family='email_link' AND active AND data->>'decision'='linked';
-- A Purchase's reviewed links, read per row by purchaseAssociatedEmailsSql.
CREATE INDEX IF NOT EXISTS "AssessmentState_email_purchase_uuid_idx" ON "AssessmentState" (((data->>'purchaseId')::uuid)) WHERE family='email_link' AND active;

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
  IF NEW.family = 'field' AND NEW."pairKey" IS NOT NULL AND jsonb_typeof(NEW.data->'served') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Paired field assessments require an explicit served flag';
  END IF;
  IF NEW.family = 'field' AND NOT EXISTS (SELECT 1 FROM "Assessment" WHERE id = NEW.id) THEN
    INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, producer, evidence, served, "createdAt")
    VALUES (NEW.id, 'field:' || NEW.id::text, 'field',
      jsonb_build_object('kind','field','entity',NEW.entity,'recordId',NEW."recordId",'field',NEW.field,'draft',false),
      jsonb_build_object('value',NEW."suggestedValue",'confidence',NEW.confidence,'runnerUpValue',NEW."runnerUpValue",'runnerUpConfidence',NEW."runnerUpConfidence",'kind',NEW.kind),
      COALESCE(NEW.provenance->>'inputFingerprint',NEW."financeReviewFingerprint"),
      CASE WHEN NEW.model = 'unknown' THEN NULL ELSE jsonb_build_object('kind','model','model',NEW.model,'revision',NULL,'runId',NEW."runId",'evaluationId',NEW."evaluationId") END,
      jsonb_build_object('currentValue',NEW."currentValue",'provenance',NEW.provenance),
      COALESCE((NEW.data->>'served')::boolean, true), NEW."createdAt");
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "AssessmentState_publish_field" ON "AssessmentState";
CREATE TRIGGER "AssessmentState_publish_field" BEFORE INSERT ON "AssessmentState" FOR EACH ROW EXECUTE FUNCTION "publish_field_assessment"();
`;

/** Inactive statement revisions retain suppression and paid labels, so history lookups cannot use an active-only index. */
export const statementSuggestionDdl = () => `
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_statement_charge_key" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey')) WHERE family='statement_transaction' AND active;
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_charge_history_idx" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey'),"createdAt" DESC,id DESC) WHERE family='statement_transaction';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_refs_idx" ON "AssessmentState" USING gin ((data->'refs')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_account_idx" ON "AssessmentState" ((data->>'accountId'),(data->>'month')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "StatementRow_source_charge_idx" ON "StatementRow" (source,(COALESCE("legacyExternalId","externalId"))) WHERE "deletedAt" IS NULL;

`;
