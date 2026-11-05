-- Direct contract cutover. The release owner holds this until the financial
-- refresh is terminal. Original transfers remain in archive, never dropped.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DO $migration$
DECLARE
  item record;
  source_oid oid := 'public."LedgerTransfer"'::regclass;
  locks text;
BEGIN
  -- Block new step admission/checkpoints while checking active work and the latest retained financial continuation.
  LOCK TABLE public."RunStep" IN SHARE MODE;
  IF EXISTS (
    SELECT 1 FROM public."RunStep" step JOIN public."Run" run ON run.id = step."runId"
    WHERE (step.key LIKE 'statement\_%' ESCAPE '\' OR step.key LIKE 'transfer\_pair\_%' ESCAPE '\')
      AND step.state NOT IN ('done', 'skipped', 'cancelled')
      AND (run.status = 'running' OR step."runId" = (
        SELECT latest."runId" FROM public."RunStep" latest
        WHERE latest.key = 'statement_generate' ORDER BY latest."createdAt" DESC, latest.id DESC LIMIT 1
      ))
  ) THEN
    RAISE EXCEPTION 'Financial refresh has unfinished steps; complete or explicitly cancel its retained work before the money cutover';
  END IF;
  -- Include incoming and outgoing FK endpoints before capturing their DDL.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname)
    INTO locks FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid IN (
      SELECT source_oid UNION
      SELECT conrelid FROM pg_constraint WHERE contype='f' AND confrelid=source_oid UNION
      SELECT confrelid FROM pg_constraint WHERE contype='f' AND conrelid=source_oid
    );
  EXECUTE 'LOCK TABLE ' || locks || ' IN ACCESS EXCLUSIVE MODE';
  IF EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid WHERE d.refobjid=source_oid) THEN
    RAISE EXCEPTION 'Ledger-transfer view dependencies require an explicit migration disposition';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."LedgerTransfer"
    WHERE "amount"::text IN ('NaN','Infinity','-Infinity')
      OR "amount"::numeric * 100 <> trunc("amount"::numeric * 100)
      OR abs("amount"::numeric * 100) > 100000000000000

  ) THEN
    RAISE EXCEPTION 'Ledger-transfer money is not exactly representable in the supported minor-unit range';
  END IF;

  CREATE TEMP TABLE transfer_money_original ON COMMIT DROP AS
    SELECT md5(to_jsonb(c)::text) hash FROM public."LedgerTransfer" c;
  CREATE TEMP TABLE transfer_money_expected ON COMMIT DROP AS
    SELECT md5(((to_jsonb(c) - 'amount') || jsonb_build_object('amountMinor',
      (c."amount"::numeric * 100)::bigint))::text) hash
    FROM public."LedgerTransfer" c;
  CREATE TEMP TABLE transfer_money_fks ON COMMIT DROP AS
    SELECT conrelid::regclass::text owner, conname, pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE contype='f' AND (conrelid=source_oid OR confrelid=source_oid);
  CREATE TEMP TABLE transfer_money_indexes ON COMMIT DROP AS
    SELECT pg_get_indexdef(indexrelid) definition FROM pg_index
    WHERE indrelid=source_oid AND NOT indisprimary;
  CREATE TEMP TABLE transfer_money_triggers ON COMMIT DROP AS
    SELECT tgname, pg_get_triggerdef(oid) definition FROM pg_trigger
    WHERE tgrelid=source_oid AND NOT tgisinternal;

  -- Capture definitions before the move, while they name the public owner.
  FOR item IN SELECT * FROM transfer_money_fks LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.owner, item.conname);
  END LOOP;
  FOR item IN SELECT * FROM transfer_money_triggers LOOP
    EXECUTE format('DROP TRIGGER %I ON public."LedgerTransfer"', item.tgname);
  END LOOP;
  CREATE SCHEMA IF NOT EXISTS archive;
  ALTER TABLE public."LedgerTransfer" SET SCHEMA archive;
  ALTER TABLE archive."LedgerTransfer" RENAME TO "LedgerTransfer_dollar_preimage";
  CREATE TABLE public."LedgerTransfer" (
    LIKE archive."LedgerTransfer_dollar_preimage" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
  );
  ALTER TABLE public."LedgerTransfer" DROP CONSTRAINT "LedgerTransfer_amount_whole_cent_check";
  ALTER TABLE public."LedgerTransfer" RENAME COLUMN amount TO "amountMinor";
  ALTER TABLE public."LedgerTransfer" ALTER COLUMN "amountMinor" TYPE bigint
    USING ("amountMinor"::numeric * 100)::bigint;
  INSERT INTO public."LedgerTransfer"
    SELECT id, shortcode, "fromPartyId", "toPartyId", (amount::numeric * 100)::bigint,
      date, notes, "createdAt", "updatedAt", "deletedAt"
    FROM archive."LedgerTransfer_dollar_preimage";
  IF EXISTS (
    SELECT 1 FROM archive."LedgerTransfer_dollar_preimage" original
    FULL JOIN public."LedgerTransfer" converted USING (id)
    WHERE original.id IS NULL OR converted.id IS NULL
      OR original.amount IS DISTINCT FROM (converted."amountMinor"::float8 / 100)
  ) THEN
    RAISE EXCEPTION 'Transfer money failed independent IEEE round-trip preservation';
  END IF;
  ALTER TABLE public."LedgerTransfer" ADD PRIMARY KEY (id);
  ALTER TABLE public."LedgerTransfer" ADD CONSTRAINT "LedgerTransfer_amount_whole_cent_check"
    CHECK ("amountMinor" > 0 AND "amountMinor" <= 100000000000000);
  FOR item IN SELECT * FROM transfer_money_indexes LOOP EXECUTE item.definition; END LOOP;
  FOR item IN SELECT * FROM transfer_money_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', item.owner, item.conname, item.definition);
  END LOOP;
  FOR item IN SELECT * FROM transfer_money_triggers LOOP EXECUTE item.definition; END LOOP;

  IF EXISTS (
    (SELECT hash FROM transfer_money_expected EXCEPT ALL SELECT md5(to_jsonb(c)::text) FROM public."LedgerTransfer" c)
    UNION ALL
    (SELECT md5(to_jsonb(c)::text) FROM public."LedgerTransfer" c EXCEPT ALL SELECT hash FROM transfer_money_expected)
  ) OR EXISTS (
    (SELECT hash FROM transfer_money_original EXCEPT ALL SELECT md5(to_jsonb(c)::text) FROM archive."LedgerTransfer_dollar_preimage" c)
    UNION ALL
    (SELECT md5(to_jsonb(c)::text) FROM archive."LedgerTransfer_dollar_preimage" c EXCEPT ALL SELECT hash FROM transfer_money_original)
  ) THEN
    RAISE EXCEPTION 'Ledger-transfer row-level preservation failed';
  END IF;
  FOR item IN SELECT i.indexrelid::regclass::text name FROM pg_index i
    WHERE i.indrelid='archive."LedgerTransfer_dollar_preimage"'::regclass AND NOT i.indisprimary LOOP
    EXECUTE 'DROP INDEX ' || item.name;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='f' AND conrelid='archive."LedgerTransfer_dollar_preimage"'::regclass)
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='archive."LedgerTransfer_dollar_preimage"'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Archived transfers retain active relationships or triggers';
  END IF;
END
$migration$;
