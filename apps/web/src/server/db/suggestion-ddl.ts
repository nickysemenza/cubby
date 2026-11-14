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
