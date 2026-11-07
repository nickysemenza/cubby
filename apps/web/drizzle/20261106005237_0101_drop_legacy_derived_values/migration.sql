-- cubby:transaction-per-statement
-- HOLD: deploy/verify reader and writer removal, retire triggers, record legacy
-- counts by key and replacement coverage, then take a named manual snapshot.
SET lock_timeout = '2s';--> statement-breakpoint
DO $$
DECLARE
  source_oid oid := to_regclass('public."DerivedValue"');
BEGIN
  IF source_oid IS NULL THEN RETURN; END IF;
  LOCK TABLE public."DerivedValue" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public."DerivedValue" WHERE "decidedBy" ? 'legacy') THEN
    RAISE EXCEPTION 'Legacy derived decisions remain; refresh per-key preservation proof';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = source_oid) THEN
    RAISE EXCEPTION 'DerivedValue still has an incoming foreign key';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = source_oid AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Retire DerivedValue source triggers before dropping its table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND
      (p.prosrc LIKE '%DerivedValue%' OR p.proname = 'derived_mark' OR p.proname LIKE 'derived_mark\_%' ESCAPE '\')
  ) THEN
    RAISE EXCEPTION 'Derived function dependencies remain; refresh the catalog trace';
  END IF;
  DROP TABLE public."DerivedValue";
END $$;--> statement-breakpoint
RESET lock_timeout;
