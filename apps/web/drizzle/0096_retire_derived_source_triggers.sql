-- cubby:transaction-per-statement
-- Reader/writer removal must already be deployed; the preceding migration installs a no-op.
-- Discover from the live catalog, never from a frozen source-table census.
CREATE OR REPLACE FUNCTION public.cubby_retire_marker_table() RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  expected bigint;
  dependency_count bigint;
  table_triggers bigint;
  target record;
  marker record;
  remaining bigint;
BEGIN
  SELECT count(*) INTO expected
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\';
  SELECT count(DISTINCT t.oid) INTO dependency_count
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_depend d ON d.classid = 'pg_trigger'::regclass AND d.objid = t.oid
    AND d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid
  WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\';
  IF dependency_count <> expected THEN
    RAISE EXCEPTION 'Trigger/function dependency census mismatch';
  END IF;
  IF expected = 0 THEN RETURN false; END IF;

  SELECT c.oid, n.nspname, c.relname INTO STRICT target
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\'
  ORDER BY c.oid LIMIT 1;
  EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE', target.nspname, target.relname);
  SELECT count(*) INTO table_triggers
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = target.oid AND p.proname LIKE 'derived\_mark\_%' ESCAPE '\';
  FOR marker IN
    SELECT t.tgname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = target.oid AND p.proname LIKE 'derived\_mark\_%' ESCAPE '\'
    ORDER BY t.tgname
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', marker.tgname, target.nspname, target.relname);
  END LOOP;
  SELECT count(*) INTO remaining
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\';
  IF remaining <> expected - table_triggers THEN
    RAISE EXCEPTION 'Trigger retirement did not match the live catalog count';
  END IF;
  RETURN remaining > 0;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'derived_mark'
    AND (prosrc LIKE '%WorkItem%' OR prosrc LIKE '%JobInvalidationCapture%')) THEN
    RAISE EXCEPTION 'Install no-op marker before retiring source triggers';
  END IF;
END $$;
--> statement-breakpoint
-- cubby:repeat-batch
-- The runner commits each table separately and applies SET LOCAL lock_timeout = '2s'.
SELECT public.cubby_retire_marker_table() AS remaining;
--> statement-breakpoint
-- Refuse BEFORE any function drop: a miss leaves the no-op installed and source writes safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'Wrapper triggers remain; shared marker retained';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.proname <> 'derived_mark'
      AND p.proname NOT LIKE 'derived\_mark\_%' ESCAPE '\'
      AND (p.prosrc ~ '\mderived_mark\M' OR EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_proc shared ON shared.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
          AND d.refclassid = 'pg_proc'::regclass AND shared.proname = 'derived_mark'
      ))) THEN
    RAISE EXCEPTION 'Other functions reference shared marker; all functions retained';
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE wrapper record;
BEGIN
  FOR wrapper IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\'
    ORDER BY p.oid
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', wrapper.signature);
  END LOOP;
END $$;
--> statement-breakpoint
-- Recheck immediately before the shared marker drop, after wrapper removal.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname LIKE 'derived\_mark\_%' ESCAPE '\') OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND p.proname <> 'derived_mark' AND (p.prosrc ~ '\mderived_mark\M' OR EXISTS (
        SELECT 1 FROM pg_depend d JOIN pg_proc shared ON shared.oid = d.refobjid
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
          AND d.refclassid = 'pg_proc'::regclass AND shared.proname = 'derived_mark'
      ))
  ) THEN RAISE EXCEPTION 'Shared marker still referenced; refusing function drop'; END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.derived_mark(text, uuid[]);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.derived_mark(text, uuid[], text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.cubby_retire_marker_table();
