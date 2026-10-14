-- The cutover owner quiesces old writers and drains/translates in-flight work
-- before this boundary, then keeps writes fenced until matching deployment.
-- Expansion is deliberately empty of copies: only this locked reconciliation
-- defines the preservation barrier. No byte hash or actor intent is reconstructed.
LOCK TABLE "Suggestion", "EmailClassificationObservation", "EmailClassificationLabel", "EmailAccuracyGrade", "ImageDescriptionCorrection", "ProductMatchCandidate", "SuggestionDismissal", "OrderMailCandidateDecision", "AiEvaluation", "AiEvaluationRequest", "Run", "RunOperation" IN ACCESS EXCLUSIVE MODE;

INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,fingerprint,producer,evidence,origin,served,"createdAt")
SELECT s.id,'legacy:Suggestion:'||s.id,'field',jsonb_build_object('kind','field','entity',s.entity,'recordId',s."recordId",'field',s.field,'draft',false),
 jsonb_build_object('value',s."suggestedValue",'confidence',s.confidence,'runnerUpValue',s."runnerUpValue",'runnerUpConfidence',s."runnerUpConfidence",'kind',s.kind),
 COALESCE(s.provenance->>'inputFingerprint',s."financeReviewFingerprint"),jsonb_build_object('kind','model','model',s.model,'revision',NULL,'runId',s."runId",'evaluationId',s."evaluationId"),
 jsonb_build_object('currentValue',s."currentValue",'provenance',s.provenance),jsonb_build_object('table','Suggestion','id',s.id,'metadata',to_jsonb(s)),
 s."pairKey" IS NULL OR COALESCE(r.input->>'decisionModel'=s.model,false),s."createdAt"
FROM "Suggestion" s LEFT JOIN "Run" r ON r.id=s."runId";
--> statement-breakpoint
INSERT INTO "AssessmentState" (id,"runId",entity,"recordId",field,"financeReviewFingerprint","evaluationId",provenance,"acceptanceReceipt","supersessionReceipt","currentValue","suggestedValue",confidence,"runnerUpValue","runnerUpConfidence",model,"pairKey",kind,status,"correctValue",family,fingerprint,suppression,"createdAt","updatedAt")
SELECT id,"runId",entity,"recordId",field,"financeReviewFingerprint","evaluationId",provenance,"acceptanceReceipt","supersessionReceipt","currentValue","suggestedValue",confidence,"runnerUpValue","runnerUpConfidence",model,"pairKey",kind,status,"correctValue",'field',COALESCE(provenance->>'inputFingerprint',"financeReviewFingerprint"),
 CASE WHEN status='rejected' THEN jsonb_build_object('scope','field_value','candidateKey',"suggestedValue"::text,'fingerprint',NULL) END,"createdAt","updatedAt" FROM "Suggestion";
--> statement-breakpoint
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,receipt,metadata,suppression,"createdAt")
SELECT id,'legacy-outcome',CASE WHEN status='rejected' AND "correctValue" IS NOT NULL THEN 'wrong' WHEN status='applied' AND "acceptanceReceipt"->>'mode'='member' THEN 'correct' ELSE 'ungraded' END,
 CASE WHEN "correctValue" IS NOT NULL THEN jsonb_build_object('present',true,'value',"correctValue") ELSE '{"present":false}'::jsonb END,
 CASE WHEN "acceptanceReceipt" IS NOT NULL THEN 'apply' ELSE 'history' END,
 CASE WHEN "acceptanceReceipt"->>'mode'='automatic' THEN 'automatic' WHEN "acceptanceReceipt"->>'mode'='member' THEN 'member' ELSE 'unknown' END,
 "acceptanceReceipt",jsonb_build_object('table','Suggestion','id',id,'status',status,'supersessionReceipt',"supersessionReceipt"),
 CASE WHEN status='rejected' THEN jsonb_build_object('scope','field_value','candidateKey',"suggestedValue"::text,'fingerprint',NULL) END,"updatedAt" FROM "Suggestion" WHERE status<>'pending';
--> statement-breakpoint
-- Classification observations remain immutable source metadata and frozen
-- rosters still name their original observation, not a resampled prediction.
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,fingerprint,producer,evidence,origin,"createdAt")
SELECT md5('EmailClassificationObservation:'||id)::uuid,'email-observation:'||id,'email_relevance',jsonb_build_object('kind','email_relevance','entity','email','recordId',"emailId",'checksum',checksum,'observationId',id),
 jsonb_build_object('classification',classification,'stage',stage),checksum,
 CASE WHEN model IS NOT NULL OR stage='rule' THEN jsonb_build_object('kind',CASE WHEN stage='rule' THEN 'rule' ELSE 'model' END,'model',model,'revision',"promptVersion",'runId',"runId",'evaluationId',"evaluationId") END,
 jsonb_build_object('checksum',checksum,'provenance',provenance),jsonb_build_object('table','EmailClassificationObservation','id',id,'metadata',to_jsonb(o)),"createdAt" FROM "EmailClassificationObservation" o;
--> statement-breakpoint
INSERT INTO "AssessmentState" (id,family,entity,"recordId",fingerprint,"suggestedValue",data,"createdAt","updatedAt")
SELECT md5('EmailClassificationObservation:'||id)::uuid,'email_relevance','email',"emailId",checksum,jsonb_build_object('classification',classification,'stage',stage),jsonb_build_object('predictionId',id),"createdAt","createdAt" FROM "EmailClassificationObservation";
--> statement-breakpoint
-- Existing member labels had operational authority. Preserve it even when
-- an old accuracy grade created the label; new evaluation grades never do.
INSERT INTO "Feedback" (id,"assessmentId","operationId",verdict,correction,reason,intent,authority,"actorUserId",metadata,"createdAt")
SELECT md5('EmailClassificationLabel:'||l.id)::uuid,md5('EmailClassificationObservation:'||l."predictionId")::uuid,'legacy-label:'||l.id,
 CASE WHEN l.classification='uncertain' THEN 'uncertain' WHEN l.classification=p.classification THEN 'correct' ELSE 'wrong' END,
 jsonb_build_object('present',true,'value',l.classification),l.reason,'history','member',l."actorUserId",jsonb_build_object('kind','email_label','predictionId',l."predictionId",'table','EmailClassificationLabel','id',l.id,'row',to_jsonb(l)),l."createdAt"
FROM "EmailClassificationLabel" l JOIN "EmailClassificationObservation" p ON p.id=l."predictionId";
--> statement-breakpoint
INSERT INTO "Feedback" (id,"assessmentId","operationId",verdict,correction,reason,intent,authority,metadata,"createdAt")
SELECT md5('EmailAccuracyGrade:'||g.id)::uuid,md5('EmailClassificationObservation:'||g."predictionId")::uuid,'email-accuracy:'||g."evaluationId"||':'||g."predictionId",
 CASE WHEN g.grade='unavailable' THEN 'ungraded' WHEN g.grade='uncertain' THEN 'uncertain' WHEN g.grade=p.classification THEN 'correct' ELSE 'wrong' END,
 CASE WHEN g.grade='unavailable' THEN '{"present":false}'::jsonb ELSE jsonb_build_object('present',true,'value',g.grade) END,g.reason,'history','evaluation',
 jsonb_build_object('kind','email_accuracy','evaluationId',g."evaluationId",'predictionId',g."predictionId",'grade',g.grade,'reviewedChecksum',g."reviewedChecksum",'table','EmailAccuracyGrade','id',g.id,'row',to_jsonb(g)),g."createdAt"
FROM "EmailAccuracyGrade" g JOIN "EmailClassificationObservation" p ON p.id=g."predictionId";
--> statement-breakpoint
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,origin,"createdAt")
SELECT md5('ImageDescriptionCorrection:'||id)::uuid,'legacy:ImageDescriptionCorrection:'||id,'image_description',jsonb_build_object('kind','image_description','entity','image','recordId',"imageId",'contentHash',NULL),'null'::jsonb,jsonb_build_object('table','ImageDescriptionCorrection','id',id,'metadata',to_jsonb(c)),"confirmedAt" FROM "ImageDescriptionCorrection" c;
--> statement-breakpoint
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,metadata,"createdAt")
SELECT md5('ImageDescriptionCorrection:'||id)::uuid,'legacy-confirmation','correct',jsonb_build_object('present',true,'value',description),'apply','member',jsonb_build_object('table','ImageDescriptionCorrection','id',id,'deletedAt',"deletedAt"),"confirmedAt" FROM "ImageDescriptionCorrection";
--> statement-breakpoint
INSERT INTO "AssessmentState" (id,family,entity,"recordId",status,"confirmedValue",active,data,"createdAt","updatedAt")
SELECT md5('ImageDescriptionCorrection:'||id)::uuid,'image_description','image',"imageId",'applied',CASE WHEN "deletedAt" IS NULL THEN jsonb_build_object('present',true,'value',description) END,"deletedAt" IS NULL,jsonb_build_object('confirmedAt',"confirmedAt",'legacyDeletedAt',"deletedAt"),"confirmedAt",COALESCE("deletedAt","confirmedAt") FROM "ImageDescriptionCorrection";
--> statement-breakpoint
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,evidence,origin,"createdAt")
SELECT md5('ProductMatchCandidate:'||id)::uuid,'legacy:ProductMatchCandidate:'||id,'product_pair',jsonb_build_object('kind','product_pair','entity','product','recordId',"productAId",'otherId',"productBId"),jsonb_build_object('actionable',false,'conflict',false),jsonb_build_object('evidence',evidence,'sourceUrls',"sourceUrls"),jsonb_build_object('table','ProductMatchCandidate','id',id,'metadata',to_jsonb(c)),"createdAt" FROM "ProductMatchCandidate" c;
--> statement-breakpoint
INSERT INTO "AssessmentState" (id,family,entity,"recordId",status,data,suppression,"createdAt","updatedAt")
SELECT md5('ProductMatchCandidate:'||id)::uuid,'product_pair','product',"productAId",CASE WHEN state='dismissed' THEN 'resolved' ELSE 'pending' END,
 jsonb_build_object('otherId',"productBId",'source',source,'evidence',evidence,'sourceUrls',"sourceUrls",'actionable',false,'conflict',false),
 CASE WHEN state='dismissed' THEN jsonb_build_object('scope','product_pair','candidateKey',"productAId"||'|'||"productBId",'fingerprint',NULL) END,"createdAt","updatedAt" FROM "ProductMatchCandidate";
--> statement-breakpoint
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,suppression,metadata,"createdAt")
SELECT md5('ProductMatchCandidate:'||id)::uuid,'legacy-dismissal','ungraded','{"present":false}'::jsonb,'history','unknown',jsonb_build_object('scope','product_pair','candidateKey',"productAId"||'|'||"productBId",'fingerprint',NULL),jsonb_build_object('table','ProductMatchCandidate','id',id,'row',to_jsonb(c)),"updatedAt" FROM "ProductMatchCandidate" c WHERE state='dismissed';
--> statement-breakpoint
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,origin,"createdAt")
SELECT md5('SuggestionDismissal:'||id)::uuid,'legacy:SuggestionDismissal:'||id,'recommendation',jsonb_build_object('kind','recommendation','entity',"entityKind",'recordId',"entityId",'scope',"suggestionKind",'candidateKey',"candidateKey"),jsonb_build_object('candidateKey',"candidateKey"),jsonb_build_object('table','SuggestionDismissal','id',id,'metadata',to_jsonb(c)),"createdAt" FROM "SuggestionDismissal" c;
--> statement-breakpoint
INSERT INTO "AssessmentState" (id,family,entity,"recordId",status,active,suppression,"createdAt","updatedAt")
SELECT md5('SuggestionDismissal:'||id)::uuid,'recommendation',"entityKind","entityId",'resolved',"deletedAt" IS NULL,CASE WHEN "deletedAt" IS NULL THEN jsonb_build_object('scope',"suggestionKind",'candidateKey',"candidateKey",'fingerprint',NULL) END,"createdAt","updatedAt" FROM "SuggestionDismissal";
--> statement-breakpoint
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,suppression,metadata,"createdAt")
SELECT md5('SuggestionDismissal:'||id)::uuid,'legacy-dismissal','dismissed','{"present":false}'::jsonb,'history','unknown',jsonb_build_object('scope',"suggestionKind",'candidateKey',"candidateKey",'fingerprint',NULL),jsonb_build_object('table','SuggestionDismissal','id',id,'row',to_jsonb(c)),"updatedAt" FROM "SuggestionDismissal" c;
--> statement-breakpoint
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,fingerprint,origin,"createdAt")
SELECT md5('OrderMailCandidateDecision:'||d.id)::uuid,'legacy:OrderMailCandidateDecision:'||d.id,'email_link',
 jsonb_build_object('kind','email_link','entity','email','recordId',e.id,'originalId',event."orderMailId",'eventId',d."eventId",'purchaseId',d."purchaseId",'checksum',d."evidenceChecksum"),
 jsonb_build_object('decision',d.decision),d."evidenceChecksum",jsonb_build_object('table','OrderMailCandidateDecision','id',d.id,'metadata',to_jsonb(d)),d."createdAt"
FROM "OrderMailCandidateDecision" d JOIN "OrderMailEvent" event ON event.id=d."eventId" LEFT JOIN "Email" e ON e."orderMailId"=event."orderMailId";
--> statement-breakpoint
INSERT INTO "AssessmentState" (id,family,entity,"recordId",status,fingerprint,data,active,"createdAt","updatedAt")
SELECT a.id,'email_link',CASE WHEN e.id IS NULL OR e."deletedAt" IS NOT NULL THEN 'orderMailEvent' ELSE 'email' END,CASE WHEN e.id IS NULL OR e."deletedAt" IS NOT NULL THEN d."eventId" ELSE e.id END,CASE WHEN event."supersededAt" IS NULL THEN 'resolved' ELSE 'superseded' END,d."evidenceChecksum",to_jsonb(d),event."supersededAt" IS NULL,d."createdAt",d."updatedAt" FROM "OrderMailCandidateDecision" d JOIN "Assessment" a ON a."publicationKey"='legacy:OrderMailCandidateDecision:'||d.id JOIN "OrderMailEvent" event ON event.id=d."eventId" LEFT JOIN "Email" e ON e.id=(a.subject->>'recordId')::uuid;
--> statement-breakpoint
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,"actorUserId",metadata,"createdAt")
SELECT a.id,'legacy-decision','ungraded',jsonb_build_object('present',true,'value',d.decision),CASE WHEN d.decision='linked' THEN 'apply' ELSE 'history' END,CASE WHEN d."proposedBy"='member' THEN 'member' ELSE 'unknown' END,d."decidedByUserId",jsonb_build_object('table','OrderMailCandidateDecision','id',d.id,'row',to_jsonb(d)),d."updatedAt" FROM "OrderMailCandidateDecision" d JOIN "Assessment" a ON a."publicationKey"='legacy:OrderMailCandidateDecision:'||d.id;
--> statement-breakpoint
-- Stored references change shape, not identity. The copied field UUID is the
-- Assessment UUID, so frozen evaluation and Run lineage remain intact.
CREATE FUNCTION pg_temp.translate_assessment_refs(value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  SELECT COALESCE(jsonb_object_agg(CASE key WHEN 'suggestionIds' THEN 'assessmentIds' WHEN 'suggestionId' THEN 'assessmentId' ELSE key END,pg_temp.translate_assessment_refs(v)),'{}'::jsonb) INTO result FROM jsonb_each(value) e(key,v); RETURN result;
 ELSIF jsonb_typeof(value)='array' THEN SELECT COALESCE(jsonb_agg(pg_temp.translate_assessment_refs(v) ORDER BY n),'[]'::jsonb) INTO result FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n); RETURN result;
 ELSE RETURN value; END IF;
END;
$$;
UPDATE "AiEvaluation" SET target=pg_temp.translate_assessment_refs(target),snapshot=pg_temp.translate_assessment_refs(snapshot),result=pg_temp.translate_assessment_refs(result),receipt=pg_temp.translate_assessment_refs(receipt);
UPDATE "AiEvaluationRequest" SET receipt=pg_temp.translate_assessment_refs(receipt);
--> statement-breakpoint
UPDATE "Run" SET input=pg_temp.translate_assessment_refs(input),progress=pg_temp.translate_assessment_refs(progress);
UPDATE "RunOperation" SET result=pg_temp.translate_assessment_refs(result);
--> statement-breakpoint
-- Fail closed before retirement if any retained origin was not covered.
DO $$
DECLARE source_table text; source_count bigint; retained_count bigint;
BEGIN
 FOREACH source_table IN ARRAY ARRAY['Suggestion','EmailClassificationObservation','ImageDescriptionCorrection','ProductMatchCandidate','SuggestionDismissal','OrderMailCandidateDecision'] LOOP
  EXECUTE format('SELECT count(*) FROM %I',source_table) INTO source_count;
  SELECT count(*) INTO retained_count FROM "Assessment" WHERE origin->>'table'=source_table;
  IF source_count<>retained_count THEN RAISE EXCEPTION 'Assessment origin preservation failed for %: source %, retained %',source_table,source_count,retained_count; END IF;
 END LOOP;
 FOREACH source_table IN ARRAY ARRAY['EmailClassificationLabel','EmailAccuracyGrade'] LOOP
  EXECUTE format('SELECT count(*) FROM %I',source_table) INTO source_count;
  SELECT count(*) INTO retained_count FROM "Feedback" WHERE metadata->>'table'=source_table;
  IF source_count<>retained_count THEN RAISE EXCEPTION 'Feedback origin preservation failed for %',source_table; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM "OrderMailCandidateDecision" d JOIN "OrderMailEvent" event ON event.id=d."eventId" LEFT JOIN "AssessmentState" s ON s.id=md5('OrderMailCandidateDecision:'||d.id)::uuid WHERE s.id IS NULL OR s.active IS DISTINCT FROM (event."supersededAt" IS NULL) OR s.data IS DISTINCT FROM to_jsonb(d)) THEN RAISE EXCEPTION 'Email event authority preservation failed'; END IF;
 IF EXISTS(SELECT 1 FROM "Suggestion" s JOIN "AssessmentState" p ON p.id=s.id WHERE p.status IS DISTINCT FROM s.status OR p."acceptanceReceipt" IS DISTINCT FROM s."acceptanceReceipt" OR p."supersessionReceipt" IS DISTINCT FROM s."supersessionReceipt") THEN RAISE EXCEPTION 'Field receipt preservation failed'; END IF;
END;
$$;
--> statement-breakpoint
DROP TABLE "EmailAccuracyGrade";
DROP TABLE "EmailClassificationLabel";
DROP TABLE "ImageDescriptionCorrection";
DROP TABLE "ProductMatchCandidate";
DROP TABLE "SuggestionDismissal";
DROP TABLE "OrderMailCandidateDecision";
DROP TABLE "Suggestion";
