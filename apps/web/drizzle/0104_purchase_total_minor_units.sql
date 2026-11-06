-- Preserve literal signed paperwork totals, including null, without changing spending.
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
  ) THEN RAISE EXCEPTION 'Financial refresh has unfinished steps; do not migrate purchase stated totals during execution'; END IF;
  LOCK TABLE public."Purchase" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM public."Purchase" evidence
    WHERE "statedTotal"::text IN ('NaN','Infinity','-Infinity')
      OR abs("statedTotal"::numeric) > 1000000000000
      OR "statedTotal"::numeric * 100 <> trunc("statedTotal"::numeric * 100)
  ) THEN RAISE EXCEPTION 'Purchase stated totals contains unproven whole-cent money; preserve it for review'; END IF;
  CREATE SCHEMA IF NOT EXISTS archive;
  CREATE TABLE archive."Purchase_dollar_preimage" AS TABLE public."Purchase";
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE contype='f' AND
      (conrelid='archive."Purchase_dollar_preimage"'::regclass OR confrelid='archive."Purchase_dollar_preimage"'::regclass)
    UNION ALL SELECT 1 FROM pg_trigger WHERE tgrelid='archive."Purchase_dollar_preimage"'::regclass AND NOT tgisinternal
    UNION ALL SELECT 1 FROM pg_index WHERE indrelid='archive."Purchase_dollar_preimage"'::regclass
  ) THEN RAISE EXCEPTION 'Archived purchase stated totals retains active relationships, triggers or indexes'; END IF;
  ALTER TABLE public."Purchase" DROP CONSTRAINT "Purchase_statedTotal_whole_cent_check";
  ALTER TABLE public."Purchase" RENAME COLUMN "statedTotal" TO "statedTotalMinor";
  ALTER TABLE public."Purchase" ALTER COLUMN "statedTotalMinor" TYPE bigint
    USING ("statedTotalMinor"::numeric * 100)::bigint;
  IF EXISTS (
    SELECT 1 FROM archive."Purchase_dollar_preimage" original
    FULL JOIN public."Purchase" converted USING(id)
    WHERE original.id IS NULL OR converted.id IS NULL
      OR original."statedTotal" IS DISTINCT FROM (converted."statedTotalMinor"::float8 / 100)
      OR to_jsonb(original)-'statedTotal' IS DISTINCT FROM to_jsonb(converted)-'statedTotalMinor'
  ) THEN RAISE EXCEPTION 'Purchase stated totals failed independent IEEE and full-row preservation'; END IF;
  ALTER TABLE public."Purchase" ADD CONSTRAINT "Purchase_statedTotal_minor_range_check"
    CHECK ("statedTotalMinor" IS NULL OR abs("statedTotalMinor") <= 100000000000000);
END;
$migration$;
