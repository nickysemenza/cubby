-- Confirmation is recorded only by the new atomic apply. Legacy approval
-- authors cannot be reconstructed reliably, so existing confirmations stay null.
UPDATE "PhotoGroupProposal"
SET "review" = ("review" - 'confirmation' - 'resolvedConcerns') || jsonb_build_object(
  'confirmation', NULL,
  'resolvedConcerns', '[]'::jsonb,
  'unresolvedReason', CASE
    WHEN "review"->>'unresolvedReason' = 'Confirm the observed identity before applying this group' THEN NULL
    ELSE "review"->>'unresolvedReason'
  END
)
WHERE "review" IS NOT NULL;
