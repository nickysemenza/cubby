-- An Email review-conflict finding stored its conflict record as
-- "proposedFix" with no fix kind, so every read of its Run failed to parse the
-- finding. The record repeats the finding's own Email ("entityId") and
-- prediction ("evidenceFingerprint"), and the conflict is always
-- accepted_unrelated (its summary), so clearing it loses nothing.
UPDATE "RunFinding"
SET "proposedFix" = NULL, "updatedAt" = now()
WHERE "entityKind" = 'email'
  AND jsonb_typeof("proposedFix") = 'object'
  AND NOT "proposedFix" ? 'kind'
  AND "proposedFix" ? 'conflict';
