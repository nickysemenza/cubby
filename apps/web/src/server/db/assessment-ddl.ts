/** Application publishers own append-only histories and projection creation. */
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
-- Every reviewed decision of an order event, joined per Email row by the
-- link-state rank: the text key and the linked-only UUID index cannot serve it.
CREATE INDEX IF NOT EXISTS "AssessmentState_email_event_uuid_idx" ON "AssessmentState" (((data->>'eventId')::uuid)) WHERE family='email_link' AND active;
-- A Purchase's reviewed links, read per row by purchaseAssociatedEmailsSql.
CREATE INDEX IF NOT EXISTS "AssessmentState_email_purchase_uuid_idx" ON "AssessmentState" (((data->>'purchaseId')::uuid)) WHERE family='email_link' AND active;

-- Removal repositories retire current targets; mail reads require a retained live event.
DROP TRIGGER IF EXISTS "Email_assessment_lifecycle" ON "Email";
DROP TRIGGER IF EXISTS "OrderMailEvent_assessment_lifecycle" ON "OrderMailEvent";
DROP FUNCTION IF EXISTS "assessment_mail_lifecycle"();

DROP TRIGGER IF EXISTS "Assessment_immutable" ON "Assessment";
DROP TRIGGER IF EXISTS "Feedback_immutable" ON "Feedback";
DROP FUNCTION IF EXISTS "assessment_history_immutable"();
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
