CREATE OR REPLACE FUNCTION "publish_field_assessment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.family = 'field' AND NOT EXISTS (SELECT 1 FROM "Assessment" WHERE id = NEW.id) THEN
    INSERT INTO "Assessment" (id, "publicationKey", family, subject, judgment, fingerprint, producer, evidence, served, "createdAt")
    VALUES (NEW.id, 'field:' || NEW.id::text, 'field',
      jsonb_build_object('kind','field','entity',NEW.entity,'recordId',NEW."recordId",'field',NEW.field,'draft',false),
      jsonb_build_object('value',NEW."suggestedValue",'confidence',NEW.confidence,'runnerUpValue',NEW."runnerUpValue",'runnerUpConfidence',NEW."runnerUpConfidence",'kind',NEW.kind),
      COALESCE(NEW.provenance->>'inputFingerprint',NEW."financeReviewFingerprint"),
      CASE WHEN NEW.model = 'unknown' THEN NULL ELSE jsonb_build_object('kind','model','model',NEW.model,'revision',NULL,'runId',NEW."runId",'evaluationId',NEW."evaluationId") END,
      jsonb_build_object('currentValue',NEW."currentValue",'provenance',NEW.provenance),
      COALESCE((NEW.data->>'served')::boolean, NEW."pairKey" IS NULL OR EXISTS(SELECT 1 FROM "Run" r WHERE r.id=NEW."runId" AND r."deletedAt" IS NULL AND r.input->>'decisionModel'=NEW.model)), NEW."createdAt");
  END IF;
  RETURN NEW;
END;
$$;
