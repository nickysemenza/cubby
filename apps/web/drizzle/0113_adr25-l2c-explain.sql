-- Retire only pending proposals for removed features. Keep evidence, decisions,
-- accepted connections and money records byte-for-byte.
LOCK TABLE "Suggestion" IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE adr25_retired_suggestions ON COMMIT DROP AS
SELECT id, to_jsonb(s) AS before FROM "Suggestion" s
WHERE family = 'recommendation' AND status = 'pending'
  AND subject->>'scope' IN ('connection.transaction-transfer', 'product.tag-propagation');
--> statement-breakpoint
UPDATE "Suggestion" s SET active = false
FROM adr25_retired_suggestions r WHERE s.id = r.id;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM adr25_retired_suggestions r
    LEFT JOIN "Suggestion" s ON s.id = r.id
    WHERE s.id IS NULL OR s.active
      OR (to_jsonb(s) - 'active') IS DISTINCT FROM (r.before - 'active')
  ) THEN
    RAISE EXCEPTION 'ADR25 suggestion retirement did not preserve a row';
  END IF;
END $$;
