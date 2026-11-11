export const suggestionHistoryDdl = () => `
-- Removal repositories retire current targets; mail reads require a retained live event.
DROP TRIGGER IF EXISTS "Email_assessment_lifecycle" ON "Email";
DROP TRIGGER IF EXISTS "OrderMailEvent_assessment_lifecycle" ON "OrderMailEvent";
DROP FUNCTION IF EXISTS "assessment_mail_lifecycle"();
DROP FUNCTION IF EXISTS "assessment_history_immutable"();
DROP FUNCTION IF EXISTS "assessment_retired_family_refused"();

-- Point-match connection endpoints. Both UUID and shortcode values remain text.
CREATE INDEX IF NOT EXISTS "Suggestion_connection_source_ref_idx" ON "Suggestion"
 ((evidence #>> '{candidate,source,entityKind}'), (evidence #>> '{candidate,source,entityId}')) INCLUDE (id)
 WHERE subject->>'scope' LIKE 'connection.%';
CREATE INDEX IF NOT EXISTS "Suggestion_connection_target_ref_idx" ON "Suggestion"
 ((evidence #>> '{candidate,target,entityKind}'), (evidence #>> '{candidate,target,entityId}')) INCLUDE (id)
 WHERE subject->>'scope' LIKE 'connection.%';
`;

/** Inactive statement revisions retain paid labels and review history, so label reuse cannot use an active-only index. */
export const statementSuggestionDdl = () => `
CREATE UNIQUE INDEX IF NOT EXISTS "Suggestion_statement_charge_key" ON "Suggestion" ((data->>'source'),(data->>'chargeKey')) WHERE family='statement_transaction' AND active;
CREATE INDEX IF NOT EXISTS "Suggestion_statement_charge_history_idx" ON "Suggestion" ((data->>'source'),(data->>'chargeKey'),"createdAt" DESC,id DESC) WHERE family='statement_transaction';
CREATE INDEX IF NOT EXISTS "Suggestion_statement_account_idx" ON "Suggestion" ((data->>'accountId'),(data->>'month')) WHERE family='statement_transaction' AND active AND status='pending';
-- These work rosters are disjoint. Native positions stream in cursor order;
-- retained positions keep the component-wise JSON override and sort only receipts.
CREATE INDEX IF NOT EXISTS "Suggestion_statement_label_native_idx" ON "Suggestion" ("createdAt",id) WHERE family='statement_transaction' AND active AND status='pending' AND ((data->>'needsLabel')::boolean OR coalesce((data->>'applicationPending')::boolean,false)) AND (data->'applicationOrder'->>'createdAt' IS NULL AND data->'applicationOrder'->>'id' IS NULL);
CREATE INDEX IF NOT EXISTS "Suggestion_statement_label_receipt_idx" ON "Suggestion" (id) WHERE family='statement_transaction' AND active AND status='pending' AND ((data->>'needsLabel')::boolean OR coalesce((data->>'applicationPending')::boolean,false)) AND NOT (data->'applicationOrder'->>'createdAt' IS NULL AND data->'applicationOrder'->>'id' IS NULL);

`;
