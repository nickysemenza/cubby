-- Direct contract cutover. The release owner holds this until the financial
-- refresh is terminal. Original claims remain in archive, never dropped.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DO $migration$
DECLARE
  item record;
  source_oid oid := 'public."LedgerSourceClaim"'::regclass;
  locks text;
BEGIN
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
    RAISE EXCEPTION 'Source-claim view dependencies require an explicit migration disposition';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."LedgerSourceClaim"
    WHERE "targetAmountAtClaim"::text IN ('NaN','Infinity','-Infinity')
      OR "targetAmountAtClaim"::numeric * 100 <> trunc("targetAmountAtClaim"::numeric * 100)
      OR abs("targetAmountAtClaim"::numeric * 100) > 100000000000000
      OR jsonb_typeof("normalizedEvidence"->'amount') IS DISTINCT FROM 'number'
      OR ("normalizedEvidence"->>'amount')::numeric * 100 <> trunc(("normalizedEvidence"->>'amount')::numeric * 100)
      OR abs(("normalizedEvidence"->>'amount')::numeric * 100) > 100000000000000
  ) THEN
    RAISE EXCEPTION 'Source-claim money is not exactly representable in the supported minor-unit range';
  END IF;

  CREATE TEMP TABLE claim_money_original ON COMMIT DROP AS
    SELECT md5(to_jsonb(c)::text) hash FROM public."LedgerSourceClaim" c;
  CREATE TEMP TABLE claim_money_expected ON COMMIT DROP AS
    SELECT md5(((to_jsonb(c) - 'targetAmountAtClaim') || jsonb_build_object('targetAmountMinor',
      (c."targetAmountAtClaim"::numeric * 100)::bigint))::text) hash
    FROM public."LedgerSourceClaim" c;
  CREATE TEMP TABLE claim_money_fks ON COMMIT DROP AS
    SELECT conrelid::regclass::text owner, conname, pg_get_constraintdef(oid) definition
    FROM pg_constraint WHERE contype='f' AND (conrelid=source_oid OR confrelid=source_oid);
  CREATE TEMP TABLE claim_money_indexes ON COMMIT DROP AS
    SELECT pg_get_indexdef(indexrelid) definition FROM pg_index
    WHERE indrelid=source_oid AND NOT indisprimary;
  CREATE TEMP TABLE claim_money_triggers ON COMMIT DROP AS
    SELECT tgname, pg_get_triggerdef(oid) definition FROM pg_trigger
    WHERE tgrelid=source_oid AND NOT tgisinternal;

  -- Capture definitions before the move, while they name the public owner.
  FOR item IN SELECT * FROM claim_money_fks LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.owner, item.conname);
  END LOOP;
  FOR item IN SELECT * FROM claim_money_triggers LOOP
    EXECUTE format('DROP TRIGGER %I ON public."LedgerSourceClaim"', item.tgname);
  END LOOP;
  CREATE SCHEMA IF NOT EXISTS archive;
  ALTER TABLE public."LedgerSourceClaim" SET SCHEMA archive;
  ALTER TABLE archive."LedgerSourceClaim" RENAME TO "LedgerSourceClaim_dollar_preimage";
  CREATE TABLE public."LedgerSourceClaim" (
    LIKE archive."LedgerSourceClaim_dollar_preimage" INCLUDING DEFAULTS INCLUDING CONSTRAINTS
  );
  ALTER TABLE public."LedgerSourceClaim" DROP CONSTRAINT "LedgerSourceClaim_reconciliation_check";
  ALTER TABLE public."LedgerSourceClaim" RENAME COLUMN "targetAmountAtClaim" TO "targetAmountMinor";
  ALTER TABLE public."LedgerSourceClaim" ALTER COLUMN "targetAmountMinor" TYPE bigint
    USING ("targetAmountMinor"::numeric * 100)::bigint;
  INSERT INTO public."LedgerSourceClaim"
    SELECT id, "expenseId", "ledgerTransferId", source, "sourceKey", "sourceKeyVersion",
      "normalizedEvidence", ("targetAmountAtClaim"::numeric * 100)::bigint,
      "reconciliationDecision", "reconciliationNote", "createdAt", "updatedAt", "deletedAt"
    FROM archive."LedgerSourceClaim_dollar_preimage";
  ALTER TABLE public."LedgerSourceClaim" ADD PRIMARY KEY (id);
  ALTER TABLE public."LedgerSourceClaim" ADD CONSTRAINT "LedgerSourceClaim_reconciliation_check" CHECK (
    abs("targetAmountMinor") <= 100000000000000
    AND coalesce(jsonb_typeof("normalizedEvidence"->'amount') = 'number', false)
    AND ("normalizedEvidence"->>'amount')::numeric * 100 = trunc(("normalizedEvidence"->>'amount')::numeric * 100)
    AND abs(("normalizedEvidence"->>'amount')::numeric * 100) <= 100000000000000
    AND (("reconciliationDecision" = 'amounts_match' AND "reconciliationNote" IS NULL
      AND ("normalizedEvidence"->>'amount')::numeric * 100 = "targetAmountMinor")
    OR ("reconciliationDecision" = 'accept_target_amount' AND length(trim("reconciliationNote")) > 0
      AND ("normalizedEvidence"->>'amount')::numeric * 100 <> "targetAmountMinor"))
  );
  FOR item IN SELECT * FROM claim_money_indexes LOOP EXECUTE item.definition; END LOOP;
  FOR item IN SELECT * FROM claim_money_fks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', item.owner, item.conname, item.definition);
  END LOOP;
  FOR item IN SELECT * FROM claim_money_triggers LOOP EXECUTE item.definition; END LOOP;

  IF EXISTS (
    (SELECT hash FROM claim_money_expected EXCEPT ALL SELECT md5(to_jsonb(c)::text) FROM public."LedgerSourceClaim" c)
    UNION ALL
    (SELECT md5(to_jsonb(c)::text) FROM public."LedgerSourceClaim" c EXCEPT ALL SELECT hash FROM claim_money_expected)
  ) OR EXISTS (
    (SELECT hash FROM claim_money_original EXCEPT ALL SELECT md5(to_jsonb(c)::text) FROM archive."LedgerSourceClaim_dollar_preimage" c)
    UNION ALL
    (SELECT md5(to_jsonb(c)::text) FROM archive."LedgerSourceClaim_dollar_preimage" c EXCEPT ALL SELECT hash FROM claim_money_original)
  ) THEN
    RAISE EXCEPTION 'Source-claim row-level preservation failed';
  END IF;
  FOR item IN SELECT i.indexrelid::regclass::text name FROM pg_index i
    WHERE i.indrelid='archive."LedgerSourceClaim_dollar_preimage"'::regclass AND NOT i.indisprimary LOOP
    EXECUTE 'DROP INDEX ' || item.name;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='f' AND conrelid='archive."LedgerSourceClaim_dollar_preimage"'::regclass)
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='archive."LedgerSourceClaim_dollar_preimage"'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Archived source claims retain active relationships or triggers';
  END IF;
END
$migration$;
