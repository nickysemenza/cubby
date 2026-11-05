/** Application publishers own append-only histories and projection creation. */
export const assessmentHistoryDdl = () => `
-- Frozen with the retired email_link rows; the ledger archive drops them, since
-- dropping them here would hold ACCESS EXCLUSIVE on State through the copy.
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_event_purchase_key" ON "AssessmentState" ((data->>'eventId'),(data->>'purchaseId')) WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_one_link_key" ON "AssessmentState" ((data->>'eventId')) WHERE family='email_link' AND active AND data->>'decision'='linked';
CREATE INDEX IF NOT EXISTS "AssessmentState_email_linked_event_uuid_idx" ON "AssessmentState" (((data->>'eventId')::uuid)) WHERE family='email_link' AND active AND data->>'decision'='linked';
CREATE INDEX IF NOT EXISTS "AssessmentState_email_event_uuid_idx" ON "AssessmentState" (((data->>'eventId')::uuid)) WHERE family='email_link' AND active;
CREATE INDEX IF NOT EXISTS "AssessmentState_email_purchase_uuid_idx" ON "AssessmentState" (((data->>'purchaseId')::uuid)) WHERE family='email_link' AND active;

-- Removal repositories retire current targets; mail reads require a retained live event.
DROP TRIGGER IF EXISTS "Email_assessment_lifecycle" ON "Email";
DROP TRIGGER IF EXISTS "OrderMailEvent_assessment_lifecycle" ON "OrderMailEvent";
DROP FUNCTION IF EXISTS "assessment_mail_lifecycle"();

DROP TRIGGER IF EXISTS "Assessment_immutable" ON "Assessment";
DROP TRIGGER IF EXISTS "Feedback_immutable" ON "Feedback";
DROP FUNCTION IF EXISTS "assessment_history_immutable"();

-- These families moved to domain owners. A stale writer fails rather than
-- losing a decision nothing reads any more; a Run deletion still detaches them.
CREATE OR REPLACE FUNCTION "assessment_retired_family_refused"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family IN ('email_relevance', 'email_link', 'mail_import_outcome', 'run_finding') THEN
    RAISE EXCEPTION 'Assessment family % moved to its domain owner', NEW.family;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "Assessment_retired_family" ON "Assessment";
CREATE TRIGGER "Assessment_retired_family" BEFORE INSERT ON "Assessment"
  FOR EACH ROW EXECUTE FUNCTION "assessment_retired_family_refused"();
DROP TRIGGER IF EXISTS "AssessmentState_retired_family" ON "AssessmentState";
CREATE TRIGGER "AssessmentState_retired_family" BEFORE INSERT OR UPDATE OF status, active, data, entity, "recordId" ON "AssessmentState"
  FOR EACH ROW EXECUTE FUNCTION "assessment_retired_family_refused"();

-- A review of a retained decision would commit where nothing reads it.
CREATE OR REPLACE FUNCTION "feedback_retired_family_refused"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Assessment" a WHERE a.id = NEW."assessmentId"
    AND a.family IN ('email_relevance', 'email_link', 'mail_import_outcome', 'run_finding')) THEN
    RAISE EXCEPTION 'Feedback on Assessment % moved to its domain owner', NEW."assessmentId";
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "Feedback_retired_family" ON "Feedback";
CREATE TRIGGER "Feedback_retired_family" BEFORE INSERT ON "Feedback"
  FOR EACH ROW EXECUTE FUNCTION "feedback_retired_family_refused"();

-- Point-match immutable connection endpoints without reopening wide evidence
-- for every unrelated Assessment. Both UUID and shortcode values remain text.
CREATE INDEX IF NOT EXISTS "Assessment_connection_source_ref_idx" ON "Assessment"
 ((evidence #>> '{candidate,source,entityKind}'), (evidence #>> '{candidate,source,entityId}')) INCLUDE (id)
 WHERE served AND subject->>'scope' LIKE 'connection.%';
CREATE INDEX IF NOT EXISTS "Assessment_connection_target_ref_idx" ON "Assessment"
 ((evidence #>> '{candidate,target,entityKind}'), (evidence #>> '{candidate,target,entityId}')) INCLUDE (id)
 WHERE served AND subject->>'scope' LIKE 'connection.%';
`;

/** Inactive statement revisions retain suppression and paid labels, so history lookups cannot use an active-only index. */
export const statementSuggestionDdl = () => `
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_statement_charge_key" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey')) WHERE family='statement_transaction' AND active;
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_charge_history_idx" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey'),"createdAt" DESC,id DESC) WHERE family='statement_transaction';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_refs_idx" ON "AssessmentState" USING gin ((data->'refs')) WHERE family='statement_transaction' AND active AND status='pending';
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_account_idx" ON "AssessmentState" ((data->>'accountId'),(data->>'month')) WHERE family='statement_transaction' AND active AND status='pending';
-- These work rosters are disjoint. Native positions stream in cursor order;
-- retained positions keep the component-wise JSON override and sort only receipts.
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_label_native_idx" ON "AssessmentState" ("createdAt",id) WHERE family='statement_transaction' AND active AND status='pending' AND ((data->>'needsLabel')::boolean OR coalesce((data->>'applicationPending')::boolean,false)) AND (data->'applicationOrder'->>'createdAt' IS NULL AND data->'applicationOrder'->>'id' IS NULL);
CREATE INDEX IF NOT EXISTS "AssessmentState_statement_label_receipt_idx" ON "AssessmentState" (id) WHERE family='statement_transaction' AND active AND status='pending' AND ((data->>'needsLabel')::boolean OR coalesce((data->>'applicationPending')::boolean,false)) AND NOT (data->'applicationOrder'->>'createdAt' IS NULL AND data->'applicationOrder'->>'id' IS NULL);

`;
