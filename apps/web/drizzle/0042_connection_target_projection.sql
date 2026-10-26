-- Carry current connection targets into the existing read projection. Retain
-- immutable evidence, decisions, suppression, status and original timestamps.
UPDATE "AssessmentState" state
SET data = coalesce(state.data, '{}'::jsonb)
  || jsonb_build_object('connectionTarget', prediction.evidence->'candidate'->'target')
FROM "Assessment" prediction
WHERE prediction.id = state.id AND state.family = 'recommendation'
  AND state.active AND state.status = 'pending' AND prediction.served
  AND prediction.subject->>'scope' LIKE 'connection.%'
  AND jsonb_typeof(prediction.evidence->'candidate'->'target') = 'object'
  AND state.data->'connectionTarget' IS DISTINCT FROM prediction.evidence->'candidate'->'target';
