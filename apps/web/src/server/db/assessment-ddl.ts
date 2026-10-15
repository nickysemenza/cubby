/** Histories are append-only even for SQL writers; projection inserts publish field evidence atomically. */
export const assessmentHistoryDdl = () => `
CREATE OR REPLACE VIEW "AssessmentEmailLink" AS
SELECT id,(data->>'eventId')::uuid AS "eventId",(data->>'purchaseId')::uuid AS "purchaseId",
 data->>'decision' AS decision,data->>'evidenceChecksum' AS "evidenceChecksum",data->>'decidedByUserId' AS "decidedByUserId",data->>'proposedBy' AS "proposedBy","createdAt","updatedAt"
FROM "AssessmentState" WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_event_purchase_key" ON "AssessmentState" ((data->>'eventId'),(data->>'purchaseId')) WHERE family='email_link' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS "AssessmentState_email_one_link_key" ON "AssessmentState" ((data->>'eventId')) WHERE family='email_link' AND active AND data->>'decision'='linked';

-- Operational mail authority follows retained events, independently of Email lifecycle.
CREATE OR REPLACE FUNCTION "assessment_mail_lifecycle"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Email' THEN
  IF TG_OP='DELETE' OR NEW."deletedAt" IS NOT NULL THEN
   UPDATE "AssessmentState" SET entity='orderMailEvent',"recordId"=(data->>'eventId')::uuid,"updatedAt"=now() WHERE family='email_link' AND entity='email' AND "recordId"=OLD.id;
   UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now() WHERE entity='email' AND "recordId"=OLD.id;
  END IF;
 ELSE
  IF TG_OP='DELETE' OR NEW."supersededAt" IS NOT NULL THEN
   UPDATE "AssessmentState" SET active=false,status='superseded',"updatedAt"=now() WHERE family='email_link' AND data->>'eventId'=OLD.id::text;
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "Email_assessment_lifecycle" ON "Email";
CREATE TRIGGER "Email_assessment_lifecycle" AFTER DELETE OR UPDATE OF "deletedAt" ON "Email" FOR EACH ROW EXECUTE FUNCTION "assessment_mail_lifecycle"();
DROP TRIGGER IF EXISTS "OrderMailEvent_assessment_lifecycle" ON "OrderMailEvent";
CREATE TRIGGER "OrderMailEvent_assessment_lifecycle" AFTER DELETE OR UPDATE OF "supersededAt" ON "OrderMailEvent" FOR EACH ROW EXECUTE FUNCTION "assessment_mail_lifecycle"();

CREATE OR REPLACE FUNCTION "assessment_history_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% history is immutable', TG_TABLE_NAME;
END;
$$;
DROP TRIGGER IF EXISTS "Assessment_immutable" ON "Assessment";
CREATE TRIGGER "Assessment_immutable" BEFORE UPDATE OR DELETE ON "Assessment" FOR EACH ROW EXECUTE FUNCTION "assessment_history_immutable"();
DROP TRIGGER IF EXISTS "Feedback_immutable" ON "Feedback";
CREATE TRIGGER "Feedback_immutable" BEFORE UPDATE OR DELETE ON "Feedback" FOR EACH ROW EXECUTE FUNCTION "assessment_history_immutable"();
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
      NEW."pairKey" IS NULL OR EXISTS(SELECT 1 FROM "Run" r WHERE r.id=NEW."runId" AND r."deletedAt" IS NULL AND r.input->>'decisionModel'=NEW.model), NEW."createdAt");
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "AssessmentState_publish_field" ON "AssessmentState";
CREATE TRIGGER "AssessmentState_publish_field" BEFORE INSERT ON "AssessmentState" FOR EACH ROW EXECUTE FUNCTION "publish_field_assessment"();
`;

/** Identity invalidation shares the current projection, including every photo attachment. */
export const productIdentityInvalidationDdl = (
  classificationFields: readonly string[],
) => `
CREATE OR REPLACE FUNCTION "retire_product_pair_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE targets uuid[] := '{}'; image_id uuid;
BEGIN
 IF TG_TABLE_NAME='Product' THEN targets=ARRAY[NEW.id];
 ELSIF TG_TABLE_NAME IN ('EntityAttachment','EntitySource','EntityExternalId') THEN
  IF TG_OP<>'INSERT' AND OLD."entityKind"='product' THEN targets=array_append(targets,OLD."entityId"); END IF;
  IF TG_OP<>'DELETE' AND NEW."entityKind"='product' THEN targets=array_append(targets,NEW."entityId"); END IF;
 ELSIF TG_TABLE_NAME='ImportSourceProduct' THEN
  IF TG_OP<>'INSERT' THEN targets=array_append(targets,OLD."productId"); END IF;
  IF TG_OP<>'DELETE' THEN targets=array_append(targets,NEW."productId"); END IF;
 ELSIF TG_TABLE_NAME='ImportSourceOrder' THEN
  SELECT array_agg("productId") INTO targets FROM "ImportSourceProduct" WHERE "sourceOrderId"=NEW.id;
 ELSIF TG_TABLE_NAME='Image' THEN image_id=NEW.id;
 ELSIF TG_TABLE_NAME='AssessmentState' THEN
  IF NEW.family='image_description' THEN image_id=NEW."recordId"; END IF;
 ELSIF TG_TABLE_NAME='AiAnalysis' THEN
  IF NEW."entityKind"='image' AND NEW.feature='image-description' THEN image_id=NEW."entityId"; END IF;
 END IF;
 IF image_id IS NOT NULL THEN
  SELECT array_agg("entityId") INTO targets FROM "EntityAttachment" WHERE "imageId"=image_id AND "entityKind"='product' AND "deletedAt" IS NULL;
 END IF;
 IF cardinality(targets)>0 THEN
  UPDATE "AssessmentState" SET status='superseded',"updatedAt"=now() WHERE family='product_pair' AND active AND ("recordId"=ANY(targets) OR (data->>'otherId')::uuid=ANY(targets));
  IF TG_TABLE_NAME<>'Product' THEN
   UPDATE "AssessmentState" SET status='superseded',"updatedAt"=now(),"supersessionReceipt"=jsonb_build_object('reason','input_changed','evaluationId',NULL,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE family='field' AND entity='product' AND active AND status='pending' AND "recordId"=ANY(targets) AND field IN (${classificationFields.map((field) => `'${field.replaceAll("'", "''")}'`).join(",") || "NULL"});
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "Product_retire_identity_pairs" ON "Product";
CREATE TRIGGER "Product_retire_identity_pairs" AFTER UPDATE OF name,manufacturer,model,aliases,"deletedAt" ON "Product" FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.manufacturer IS DISTINCT FROM NEW.manufacturer OR OLD.model IS DISTINCT FROM NEW.model OR OLD.aliases IS DISTINCT FROM NEW.aliases OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt") EXECUTE FUNCTION "retire_product_pair_evidence"();
${[
  "EntityAttachment",
  "EntitySource",
  "EntityExternalId",
  "ImportSourceProduct",
]
  .map(
    (
      table,
    ) => `DROP TRIGGER IF EXISTS "${table}_retire_identity_pairs" ON "${table}";
CREATE TRIGGER "${table}_retire_identity_pairs" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();`,
  )
  .join("\n")}
DROP TRIGGER IF EXISTS "ImportSourceOrder_retire_identity_pairs" ON "ImportSourceOrder";
CREATE TRIGGER "ImportSourceOrder_retire_identity_pairs" AFTER UPDATE ON "ImportSourceOrder" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "Image_retire_identity_pairs" ON "Image";
CREATE TRIGGER "Image_retire_identity_pairs" AFTER UPDATE OF sha256,"deletedAt" ON "Image" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "AssessmentState_retire_image_identity_pairs" ON "AssessmentState";
CREATE TRIGGER "AssessmentState_retire_image_identity_pairs" AFTER UPDATE OF "confirmedValue",active ON "AssessmentState" FOR EACH ROW WHEN (OLD."confirmedValue" IS DISTINCT FROM NEW."confirmedValue" OR OLD.active IS DISTINCT FROM NEW.active) EXECUTE FUNCTION "retire_product_pair_evidence"();
DROP TRIGGER IF EXISTS "AiAnalysis_retire_image_identity_pairs" ON "AiAnalysis";
CREATE TRIGGER "AiAnalysis_retire_image_identity_pairs" AFTER INSERT OR UPDATE ON "AiAnalysis" FOR EACH ROW EXECUTE FUNCTION "retire_product_pair_evidence"();
`;
