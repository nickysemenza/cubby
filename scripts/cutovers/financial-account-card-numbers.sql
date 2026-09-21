-- TEMPORARY: run in Neon after `db:push` adds "FinancialAccount"."cardNumbers"
-- and BEFORE deploying app code that reads it — the new identity schema is
-- strict and rejects any row still carrying `identity.last4`. Delete this file
-- after verification and before merge.
--
-- Every account's single statement-labelled last four becomes its open-ended
-- primary card. Soft-deleted rows are migrated too so later reads still parse.
BEGIN;

UPDATE "FinancialAccount"
SET "cardNumbers" = jsonb_build_array(jsonb_build_object(
      'last4', identity->>'last4',
      'kind', 'primary',
      'validFrom', NULL,
      'validTo', NULL,
      'note', NULL)),
    identity = identity - 'last4'
WHERE identity ? 'last4'
  AND identity->>'last4' IS NOT NULL
  AND jsonb_array_length("cardNumbers") = 0;

UPDATE "FinancialAccount"
SET identity = identity - 'last4'
WHERE identity ? 'last4';

-- Must return zero rows.
SELECT shortcode, identity
FROM "FinancialAccount"
WHERE identity ? 'last4';

SELECT shortcode, name, identity->>'kind' AS kind, "cardNumbers"
FROM "FinancialAccount"
ORDER BY name;

COMMIT;
