-- Materialize serving authority before removing the automatic Run pins.
LOCK TABLE "Run", "AiEvaluation", "AssessmentState" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE "AssessmentState" s
SET data = jsonb_set(COALESCE(s.data, '{}'::jsonb), '{served}',
  to_jsonb(s."pairKey" IS NULL OR EXISTS (
    SELECT 1 FROM "Run" r WHERE r.id=s."runId" AND r."deletedAt" IS NULL
      AND r.input->>'decisionModel'=s.model)))
WHERE s.family='field' AND NOT (COALESCE(s.data, '{}'::jsonb) ? 'served');
--> statement-breakpoint
UPDATE "AssessmentState" SET data = data - 'pinnedModel'
WHERE data ? 'pinnedModel';
--> statement-breakpoint
UPDATE "AiEvaluation" e
SET result = jsonb_set(e.result, '{entries}', (
  SELECT COALESCE(jsonb_agg(CASE WHEN entry ? 'served' THEN entry ELSE
    entry || jsonb_build_object('served', entry->>'pairKey' IS NULL OR
      (r."deletedAt" IS NULL AND COALESCE(r.input->>'decisionModel'=entry->>'model', false))) END ORDER BY position), '[]'::jsonb)
  FROM jsonb_array_elements(e.result->'entries') WITH ORDINALITY AS items(entry, position)))
FROM "Run" r
WHERE e."runId"=r.id AND e."executionKind"='suggestion_sweep'
  AND jsonb_typeof(e.result->'entries')='array';
--> statement-breakpoint
UPDATE "AiEvaluation" SET snapshot = snapshot - 'decisionModel'
WHERE snapshot ? 'decisionModel';
--> statement-breakpoint
UPDATE "AiEvaluation" SET snapshot = jsonb_set(snapshot, '{input}', (snapshot->'input') - 'decisionModel')
WHERE "executionKind"='suggestion_sweep' AND (snapshot->'input') ? 'decisionModel';
--> statement-breakpoint
UPDATE "Run" SET input = input - 'decisionModel'
WHERE input ? 'decisionModel';
--> statement-breakpoint
UPDATE "AssessmentState" SET data = jsonb_set(data, '{labelCheckpoint,models}',
  CASE WHEN data->'labelCheckpoint'->>'model' IS NULL THEN '[]'::jsonb
       ELSE jsonb_build_array(data->'labelCheckpoint'->>'model') END)
WHERE family='statement_transaction' AND jsonb_typeof(data->'labelCheckpoint')='object'
  AND NOT ((data->'labelCheckpoint') ? 'models');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "publish_field_assessment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family = 'field' AND NEW."pairKey" IS NOT NULL AND jsonb_typeof(NEW.data->'served') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Paired field assessments require an explicit served flag';
  END IF;
  IF NEW.family = 'field' AND NOT EXISTS (SELECT 1 FROM "Assessment" WHERE id = NEW.id) THEN
    INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, producer, evidence, served, "createdAt")
    VALUES (NEW.id, 'field:' || NEW.id::text, 'field',
      jsonb_build_object('kind','field','entity',NEW.entity,'recordId',NEW."recordId",'field',NEW.field,'draft',false),
      jsonb_build_object('value',NEW."suggestedValue",'confidence',NEW.confidence,'runnerUpValue',NEW."runnerUpValue",'runnerUpConfidence',NEW."runnerUpConfidence",'kind',NEW.kind),
      COALESCE(NEW.provenance->>'inputFingerprint',NEW."financeReviewFingerprint"),
      CASE WHEN NEW.model = 'unknown' THEN NULL ELSE jsonb_build_object('kind','model','model',NEW.model,'revision',NULL,'runId',NEW."runId",'evaluationId',NEW."evaluationId") END,
      jsonb_build_object('currentValue',NEW."currentValue",'provenance',NEW.provenance),
      COALESCE((NEW.data->>'served')::boolean, true), NEW."createdAt");
  END IF;
  RETURN NEW;
END;
$$;
