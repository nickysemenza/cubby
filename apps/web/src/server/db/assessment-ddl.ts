/** Histories are append-only even for SQL writers; application publishers own projection creation. */
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
`;

/** Inactive statement revisions retain suppression and paid labels, so history lookups cannot use an active-only index. */
export const statementSuggestionDdl = () => `
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_statement_charge_key" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey')) WHERE family='statement_transaction' AND active;
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_charge_history_idx" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey'),"createdAt" DESC,id DESC) WHERE family='statement_transaction';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_refs_idx" ON "AssessmentState" USING gin ((data->'refs')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_account_idx" ON "AssessmentState" ((data->>'accountId'),(data->>'month')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "StatementRow_source_charge_idx" ON "StatementRow" (source,(COALESCE("legacyExternalId","externalId"))) WHERE "deletedAt" IS NULL;

`;
