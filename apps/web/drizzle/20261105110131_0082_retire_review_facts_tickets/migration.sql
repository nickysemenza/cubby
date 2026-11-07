-- These tickets owed the deleted read pipeline, and no trigger marks them now. The
-- drain never claimed them, and they hold no member decision, evidence or paid work.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc LIKE '%assessment.reviewFacts%'
  ) THEN
    RAISE EXCEPTION 'A function still marks assessment.reviewFacts tickets';
  END IF;
END $check$;
--> statement-breakpoint
DELETE FROM "WorkItem"
WHERE target LIKE 'assessment.reviewFacts%' AND drain = 'derived:drain';
--> statement-breakpoint
DO $check$
BEGIN
  -- The drain now claims every target, so a survivor would fail with no compute.
  IF EXISTS (SELECT 1 FROM "WorkItem" WHERE target LIKE 'assessment.reviewFacts%') THEN
    RAISE EXCEPTION 'assessment.reviewFacts tickets remain outside derived:drain';
  END IF;
END $check$;
