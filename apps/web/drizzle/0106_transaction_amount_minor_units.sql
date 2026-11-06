-- Settled transaction amounts keeps its signed USD value; originals remain inert in archive.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DO $migration$
BEGIN
  LOCK TABLE public."Run", public."Job", public."RunStep" IN SHARE MODE;
  IF EXISTS (
    SELECT 1 FROM public."RunStep" step JOIN public."Run" run ON run.id=step."runId"
    WHERE (step.key LIKE 'statement\_%' ESCAPE '\' OR step.key LIKE 'transfer\_pair\_%' ESCAPE '\')
      AND step.state <> 'done'
      AND (run.status='running' OR step."runId"=(SELECT latest."runId" FROM public."RunStep" latest
        WHERE latest.key='statement_generate' ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1))
      AND NOT (run.status='failed' AND run."failureCode" IS NOT DISTINCT FROM 'user_cancelled' AND run."endedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public."Job" execution WHERE execution."runId"=run.id
          AND execution.state NOT IN ('completed','failed','cancelled')))
  ) THEN RAISE EXCEPTION 'Financial refresh has unfinished steps; do not migrate transaction amounts during execution'; END IF;
  LOCK TABLE public."FinancialTransaction" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM public."FinancialTransaction" evidence
    WHERE amount::text IN ('NaN','Infinity','-Infinity')
      OR abs(amount::numeric) > 1000000000000
      OR amount::numeric * 100 <> trunc(amount::numeric * 100)
  ) THEN RAISE EXCEPTION 'Transaction money contains unproven whole-cent money; preserve it for review'; END IF;
  CREATE SCHEMA IF NOT EXISTS archive;
  CREATE TABLE archive."FinancialTransaction_dollar_preimage" AS TABLE public."FinancialTransaction";
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE contype='f' AND
      (conrelid='archive."FinancialTransaction_dollar_preimage"'::regclass OR confrelid='archive."FinancialTransaction_dollar_preimage"'::regclass)
    UNION ALL SELECT 1 FROM pg_trigger WHERE tgrelid='archive."FinancialTransaction_dollar_preimage"'::regclass AND NOT tgisinternal
    UNION ALL SELECT 1 FROM pg_index WHERE indrelid='archive."FinancialTransaction_dollar_preimage"'::regclass
  ) THEN RAISE EXCEPTION 'Archived transaction amounts retains active relationships, triggers or indexes'; END IF;
  ALTER TABLE public."FinancialTransaction" DROP CONSTRAINT "FinancialTransaction_amount_whole_cent_check";
  -- ALTER TYPE otherwise retains float casts in these existing sign predicates.
  DROP INDEX public."FinancialTransaction_ledgerTransferId_negative_evidence_key";
  DROP INDEX public."FinancialTransaction_ledgerTransferId_positive_evidence_key";
  ALTER TABLE public."FinancialTransaction" RENAME COLUMN amount TO "amountMinor";
  ALTER TABLE public."FinancialTransaction" ALTER COLUMN "amountMinor" TYPE bigint
    USING ("amountMinor"::numeric * 100)::bigint;
  CREATE UNIQUE INDEX "FinancialTransaction_ledgerTransferId_negative_evidence_key"
    ON public."FinancialTransaction" ("ledgerTransferId") WHERE "deletedAt" IS NULL AND "ledgerTransferId" IS NOT NULL AND "amountMinor" < 0;
  CREATE UNIQUE INDEX "FinancialTransaction_ledgerTransferId_positive_evidence_key"
    ON public."FinancialTransaction" ("ledgerTransferId") WHERE "deletedAt" IS NULL AND "ledgerTransferId" IS NOT NULL AND "amountMinor" > 0;
  IF EXISTS (
    SELECT 1 FROM archive."FinancialTransaction_dollar_preimage" original
    FULL JOIN public."FinancialTransaction" converted USING(id)
    WHERE original.id IS NULL OR converted.id IS NULL
      OR original.amount IS DISTINCT FROM (converted."amountMinor"::float8 / 100)
      OR to_jsonb(original)-'amount' IS DISTINCT FROM to_jsonb(converted)-'amountMinor'
  ) THEN RAISE EXCEPTION 'Transaction money failed independent IEEE and full-row preservation'; END IF;
  ALTER TABLE public."FinancialTransaction" ADD CONSTRAINT "FinancialTransaction_amount_minor_range_check"
    CHECK ("amountMinor" <> 0 AND abs("amountMinor") <= 100000000000000);
END;
$migration$;
