-- Agent product pairs survive enrichment: only deleting a Product retires them; review fingerprints them live.
CREATE OR REPLACE FUNCTION "retire_product_pair_evidence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE targets uuid[] := '{}'; image_id uuid; product_deleted boolean := false;
BEGIN
 IF TG_TABLE_NAME='Product' THEN targets=ARRAY[NEW.id]; product_deleted=NEW."deletedAt" IS NOT NULL;
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
  UPDATE "AssessmentState" SET status='superseded',"updatedAt"=now() WHERE family='product_pair' AND active AND ("recordId"=ANY(targets) OR (data->>'otherId')::uuid=ANY(targets)) AND (data->>'source' IS DISTINCT FROM 'agent' OR product_deleted);
  IF TG_TABLE_NAME<>'Product' THEN
   UPDATE "AssessmentState" SET status='superseded',"updatedAt"=now(),"supersessionReceipt"=jsonb_build_object('reason','input_changed','evaluationId',NULL,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE family='field' AND entity='product' AND active AND status='pending' AND "recordId"=ANY(targets) AND field IN ('categoryId');
  END IF;
 END IF;
 RETURN NULL;
END;
$$;
