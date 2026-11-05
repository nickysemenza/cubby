-- cubby:transaction-per-statement
-- HOLD: deploy the declaration removal first using the exact preceding journal
-- boundary, verify the view, then snapshot and apply this contraction alone.
SET lock_timeout = '2s';--> statement-breakpoint
DO $$
DECLARE
  source_oid oid := to_regclass('public."ProjectReadSnapshot"');
  legacy_remains boolean;
BEGIN
  IF source_oid IS NULL OR to_regclass('public."ProjectStartDateView"') IS NULL THEN
    RAISE EXCEPTION 'Project typed rollups and start-date view must remain';
  END IF;
  LOCK TABLE public."ProjectReadSnapshot" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = source_oid AND attname = 'startDateDecision' AND NOT attisdropped) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public."ProjectReadSnapshot" WHERE "startDateDecision" ? ''legacy'')' INTO legacy_remains;
    IF legacy_remains THEN RAISE EXCEPTION 'Legacy Project start-date decisions remain'; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refobjid = source_oid AND a.attname IN ('startDate', 'startDateDecision', 'startDateComputedAt', 'startDateSort')
  ) THEN
    RAISE EXCEPTION 'Retired Project start-date columns still have catalog dependents';
  END IF;
  ALTER TABLE public."ProjectReadSnapshot"
    DROP COLUMN IF EXISTS "startDate", DROP COLUMN IF EXISTS "startDateDecision",
    DROP COLUMN IF EXISTS "startDateComputedAt", DROP COLUMN IF EXISTS "startDateSort";
END $$;--> statement-breakpoint
RESET lock_timeout;
