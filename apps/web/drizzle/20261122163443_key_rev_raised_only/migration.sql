-- KeyRev holds only raised keys. An absent key reads 0, so every rev-0 row is
-- removed and the table refuses a revision below 1. Neither a foreign key nor
-- a trigger references KeyRev, so TRUNCATE returns the storage inside this
-- transaction. The constraint is added after the rebuild; a Worker that still
-- materialises a zero row fails its statement and rolls back its apply.
LOCK TABLE "KeyRev" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  rev_total bigint;
  rev_zero bigint;
  rev_after bigint;
  referenced bigint;
BEGIN
  SELECT count(*) INTO referenced FROM pg_constraint
    WHERE confrelid = '"KeyRev"'::regclass;
  IF referenced <> 0 THEN
    RAISE EXCEPTION 'KeyRev rebuild: % foreign keys reference KeyRev', referenced;
  END IF;
  SELECT count(*) INTO referenced FROM pg_trigger
    WHERE tgrelid = '"KeyRev"'::regclass AND NOT tgisinternal;
  IF referenced <> 0 THEN
    RAISE EXCEPTION 'KeyRev rebuild: % triggers on KeyRev', referenced;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE rev <= 0)
    INTO rev_total, rev_zero
  FROM "KeyRev";
  CREATE TEMP TABLE key_rev_keep ON COMMIT DROP AS
    SELECT key, rev FROM "KeyRev" WHERE rev > 0;
  TRUNCATE "KeyRev";
  INSERT INTO "KeyRev" (key, rev) SELECT key, rev FROM key_rev_keep ORDER BY key;
  SELECT count(*) INTO rev_after FROM "KeyRev";
  IF rev_after <> rev_total - rev_zero THEN
    RAISE EXCEPTION 'KeyRev rebuild: kept % rows, expected %',
      rev_after, rev_total - rev_zero;
  END IF;
  IF EXISTS (SELECT 1 FROM key_rev_keep k
    WHERE NOT EXISTS (SELECT 1 FROM "KeyRev" r WHERE r.key = k.key AND r.rev = k.rev)) THEN
    RAISE EXCEPTION 'KeyRev rebuild: a kept revision changed';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "KeyRev" ALTER COLUMN "rev" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "KeyRev" ADD CONSTRAINT "KeyRev_raised_check" CHECK ("rev" > 0);--> statement-breakpoint
ANALYZE "KeyRev";
