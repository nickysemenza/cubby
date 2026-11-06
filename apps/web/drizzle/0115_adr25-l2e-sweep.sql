-- Keep identities, demand, frozen evidence and execution checkpoints in place.
LOCK TABLE "Run", "RunStep", "Job", "AiEvaluation", "AiEvaluationRequest" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE l2e_runs ON COMMIT DROP AS SELECT * FROM "Run" WHERE purpose = 'suggestion_sweep';
CREATE TEMP TABLE l2e_jobs ON COMMIT DROP AS SELECT j.* FROM "Job" j
WHERE j."runId" IN (SELECT id FROM l2e_runs)
   OR j.input->>'runId' IN (SELECT id::text FROM l2e_runs);
CREATE TEMP TABLE l2e_evaluations ON COMMIT DROP AS SELECT e.* FROM "AiEvaluation" e
WHERE e."executionKind" = 'suggestion_sweep' OR e."runId" IN (SELECT id FROM l2e_runs)
   OR e.id IN (SELECT "evaluationId" FROM "AiEvaluationRequest" WHERE "runId" IN (SELECT id FROM l2e_runs));
CREATE TEMP TABLE l2e_requests ON COMMIT DROP AS SELECT * FROM "AiEvaluationRequest" WHERE "runId" IN (SELECT id FROM l2e_runs);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM l2e_runs WHERE input->>'kind' IS DISTINCT FROM 'suggestion_sweep'
    OR jsonb_typeof(input->'entity') IS DISTINCT FROM 'string'
    OR jsonb_typeof(input->'fields') IS DISTINCT FROM 'array'
    OR jsonb_array_length(input->'fields') = 0
    OR jsonb_typeof(input->'filters') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'L2e: cannot preserve malformed field sweep targets';
  END IF;
  IF EXISTS (SELECT 1 FROM "RunStep" WHERE "runId" IN (SELECT id FROM l2e_runs)) THEN
    RAISE EXCEPTION 'L2e: legacy sweep already has a step ledger';
  END IF;
  IF EXISTS (SELECT 1 FROM l2e_runs WHERE "endedAt" IS NULL
    AND coalesce((progress->>'rosterPrepared')::boolean, false) = false
    AND (coalesce((progress->>'done')::int, 0) > 0 OR coalesce(jsonb_array_length(progress->'processedTargetIds'),0) > 0)) THEN
    RAISE EXCEPTION 'L2e: unfinished legacy progress has no durable roster to verify';
  END IF;
  IF EXISTS (SELECT 1 FROM l2e_jobs WHERE kind = 'run.execute' AND input->>'purpose' IS DISTINCT FROM 'suggestion_sweep') THEN
    RAISE EXCEPTION 'L2e: Run execution purpose mismatch';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";
--> statement-breakpoint
UPDATE "Run" SET purpose = 'sweep', input = jsonb_build_object(
  'kind', 'sweep', 'families', jsonb_build_array(jsonb_build_object(
    'family', 'field', 'scope', jsonb_build_object('targets', jsonb_build_array(
      jsonb_build_object('entity', input->'entity', 'fields', input->'fields', 'filters', input->'filters'))))))
WHERE id IN (SELECT id FROM l2e_runs);
UPDATE "Job" SET input = jsonb_set(input, '{purpose}', '"sweep"'::jsonb)
WHERE id IN (SELECT id FROM l2e_jobs) AND kind = 'run.execute';
-- The pinned model and taxonomy belong to each evaluation, not Run input.
UPDATE "AiEvaluation" e SET snapshot = jsonb_set(e.snapshot, '{input}',
  ((e.snapshot->'input') - 'kind' - 'paused' - 'decisionModelOverride') ||
  CASE WHEN e.snapshot->'input' ? 'decisionModelOverride'
    THEN jsonb_build_object('model', e.snapshot->'input'->'decisionModelOverride') ELSE '{}'::jsonb END)
WHERE e.id IN (SELECT id FROM l2e_evaluations) AND e."executionKind" = 'suggestion_sweep';
INSERT INTO "RunStep" ("runId", key, label, position, state, found, done, cursor, meta, "startedAt", "endedAt")
SELECT id, 'field_roster', 'Fields: roster', 0,
  CASE WHEN "endedAt" IS NOT NULL OR coalesce((progress->>'rosterPrepared')::boolean,false) THEN 'done' ELSE 'queued' END,
  1, CASE WHEN "endedAt" IS NOT NULL OR coalesce((progress->>'rosterPrepared')::boolean,false) THEN 1 ELSE 0 END,
  CASE WHEN "endedAt" IS NOT NULL OR coalesce((progress->>'rosterPrepared')::boolean,false) THEN '1'::jsonb ELSE '0'::jsonb END,
  jsonb_build_object('input', jsonb_build_object('mode','count','boundary',null)), "createdAt", "endedAt"
FROM l2e_runs;
INSERT INTO "RunStep" ("runId", key, label, position, state, found, done, failed, meta, "startedAt", "endedAt")
SELECT id, 'field_evaluate', 'Fields: evaluate', 1,
  CASE WHEN "endedAt" IS NOT NULL THEN CASE WHEN status = 'failed' THEN 'failed' ELSE 'done' END ELSE 'queued' END,
  coalesce((progress->>'total')::int, 0),
  greatest(coalesce((progress->>'done')::int, 0) - coalesce((progress->>'failed')::int, 0), 0),
  coalesce((progress->>'failed')::int, 0),
  jsonb_build_object('detail', jsonb_build_object('retainedProgress', coalesce(progress::text, 'null'))), "createdAt", "endedAt"
FROM l2e_runs;
--> statement-breakpoint
DO $$ BEGIN
  IF (SELECT count(*) FROM "Run" WHERE id IN (SELECT id FROM l2e_runs)) <> (SELECT count(*) FROM l2e_runs)
    OR (SELECT count(*) FROM "RunStep" WHERE "runId" IN (SELECT id FROM l2e_runs)) <> 2 * (SELECT count(*) FROM l2e_runs)
    OR (SELECT count(*) FROM "AiEvaluationRequest" WHERE "runId" IN (SELECT id FROM l2e_runs)) <> (SELECT count(*) FROM l2e_requests)
    OR (SELECT count(*) FROM "Job" WHERE id IN (SELECT id FROM l2e_jobs)) <> (SELECT count(*) FROM l2e_jobs)
    OR (SELECT count(*) FROM "AiEvaluation" WHERE id IN (SELECT id FROM l2e_evaluations)) <> (SELECT count(*) FROM l2e_evaluations) THEN
    RAISE EXCEPTION 'L2e: retained row count mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM l2e_runs old LEFT JOIN "Run" new USING (id)
    WHERE (to_jsonb(new) - 'purpose' - 'input') IS DISTINCT FROM (to_jsonb(old) - 'purpose' - 'input')
    OR new.purpose IS DISTINCT FROM 'sweep'
    OR new.input IS DISTINCT FROM jsonb_build_object('kind','sweep','families',jsonb_build_array(jsonb_build_object('family','field','scope',jsonb_build_object('targets',jsonb_build_array(jsonb_build_object('entity',old.input->'entity','fields',old.input->'fields','filters',old.input->'filters'))))))
    OR NOT EXISTS (SELECT 1 FROM "RunStep" s WHERE s."runId"=old.id AND s.key='field_evaluate' AND s.meta->'detail'->>'retainedProgress' IS NOT DISTINCT FROM coalesce(old.progress::text, 'null')
      AND s.found = coalesce((old.progress->>'total')::int, 0)
      AND s.done = greatest(coalesce((old.progress->>'done')::int, 0) - coalesce((old.progress->>'failed')::int, 0), 0)
      AND s.failed = coalesce((old.progress->>'failed')::int, 0))
    OR NOT EXISTS (SELECT 1 FROM "RunStep" s WHERE s."runId"=old.id AND s.key='field_roster'
      AND s.found=1
      AND s.cursor = CASE WHEN old."endedAt" IS NOT NULL OR coalesce((old.progress->>'rosterPrepared')::boolean,false) THEN '1'::jsonb ELSE '0'::jsonb END)) THEN
    RAISE EXCEPTION 'L2e: Run identity, targets, status or progress mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM l2e_jobs old LEFT JOIN "Job" new USING (id)
    WHERE to_jsonb(new) IS DISTINCT FROM CASE WHEN old.kind='run.execute'
      THEN jsonb_set(to_jsonb(old),'{input,purpose}','"sweep"'::jsonb) ELSE to_jsonb(old) END) THEN
    RAISE EXCEPTION 'L2e: Job state, cursor or work mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM l2e_requests old LEFT JOIN "AiEvaluationRequest" new USING (id)
    WHERE to_jsonb(new) IS DISTINCT FROM to_jsonb(old)) THEN
    RAISE EXCEPTION 'L2e: evaluation request mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM l2e_evaluations old LEFT JOIN "AiEvaluation" new USING (id)
    WHERE (to_jsonb(new)-'snapshot') IS DISTINCT FROM (to_jsonb(old)-'snapshot')
    OR new.snapshot IS DISTINCT FROM CASE WHEN old."executionKind"='suggestion_sweep' THEN
      jsonb_set(old.snapshot,'{input}', ((old.snapshot->'input') - 'kind' - 'paused' - 'decisionModelOverride') || CASE WHEN old.snapshot->'input' ? 'decisionModelOverride' THEN jsonb_build_object('model',old.snapshot->'input'->'decisionModelOverride') ELSE '{}'::jsonb END)
      ELSE old.snapshot END) THEN
    RAISE EXCEPTION 'L2e: evaluation target, evidence, result or state mismatch';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'ai_refresh', 'background', 'file_import', 'mail_search', 'mail_discovery', 'mail_reclassify', 'connection_discovery', 'maintenance', 'derived_refresh', 'sweep'));
