LOCK TABLE "Job", "SearchDocument", "EntityEmbedding", "ImageProcessingJob", "ImageProcessingAttempt", "ImageProcessingEvent", "AiUsage", "Image", "Entity", "Ask", "Answer", "AskScope", "Pass" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "ImageEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"inputHash" text NOT NULL UNIQUE,
	"kind" text NOT NULL,
	"value" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "EntityEmbedding_cleanup_idx";--> statement-breakpoint
DROP INDEX "EntityEmbedding_deletion_exhausted_idx";--> statement-breakpoint
DROP INDEX "SearchDocument_embedding_due_idx";--> statement-breakpoint
DROP INDEX "SearchDocument_embedding_exhausted_idx";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" ADD COLUMN "askId" uuid;--> statement-breakpoint
ALTER TABLE "Answer" ADD COLUMN "claimToken" uuid;--> statement-breakpoint
ALTER TABLE "Answer" ADD COLUMN "executor" text;--> statement-breakpoint
ALTER TABLE "Ask" ADD COLUMN "executor" text;--> statement-breakpoint
ALTER TABLE "ImageEvidence" ADD CONSTRAINT "ImageEvidence_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "Entity"("id","kind");
--> statement-breakpoint
CREATE FUNCTION pg_temp.kernel_canonical(v jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text;
BEGIN
 CASE jsonb_typeof(v)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||pg_temp.kernel_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(v);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(pg_temp.kernel_canonical(value),',' ORDER BY ord),'')||']' INTO result FROM jsonb_array_elements(v) WITH ORDINALITY AS a(value,ord);
 ELSE result:=v::text;
 END CASE;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.kernel_hash(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(convert_to(pg_temp.kernel_canonical(v),'UTF8')),'hex') $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.image_envelope(receipt uuid, image_id uuid, source_hash text, revision integer, kind text, lane text, generation integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('feature','image.'||lane,'producer','image','tier',null,'model',null,'parameters',null,'outputRevision','1','promptVersion','1','input',jsonb_build_object('receiptId',receipt,'imageId',image_id,'sourceContentHash',source_hash,'processorRevision',revision,'kind',kind,'generation',generation))
$$;
--> statement-breakpoint
CREATE TEMP TABLE image_carry AS
SELECT CASE WHEN j.state NOT IN ('pending','leased','waiting_for_device')
 AND a.number=(SELECT max(latest.number) FROM "ImageProcessingAttempt" latest WHERE latest."jobId"=j.id AND latest.result IS NOT NULL)
 THEN j.id ELSE gen_random_uuid() END AS id,a.id AS token,j.id AS receipt,j."runId",coalesce(a.executor->>'deviceId','cloud') AS executor,
 pg_temp.image_envelope(j.id,j."imageId",j."sourceContentHash",j."processorRevision",j.kind,j.lane,a.number-1) AS envelope,
 a.result,a."completedAt",a."startedAt",a.error,a.number
FROM "ImageProcessingAttempt" a JOIN "ImageProcessingJob" j ON j.id=a."jobId"
WHERE a.result IS NOT NULL;
CREATE INDEX ON image_carry (receipt,number);
CREATE INDEX ON image_carry (id);
ANALYZE image_carry;
--> statement-breakpoint
INSERT INTO "Ask" (id,"inputHash",feature,producer,"promptVersion",input,state,executor,"answeredAt",attempts,"maxAttempts")
SELECT id,pg_temp.kernel_hash(envelope),envelope->>'feature','image','1',envelope,'answered',executor,coalesce("completedAt","startedAt"),0,5 FROM image_carry;
--> statement-breakpoint
INSERT INTO "Answer" ("inputHash",feature,producer,"promptVersion",output,"askId","claimToken",executor,"runId",model,"costMicros",raw)
SELECT pg_temp.kernel_hash(c.envelope),c.envelope->>'feature','image','1',jsonb_build_object('jobId',c.id,'attemptId',c.token,'completedAt',to_char(coalesce(c."completedAt",c."startedAt"),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'outcome',c.result),c.id,c.token,c.executor,c."runId",a.diagnostics->'runtime'->>'model',
 (SELECT round(coalesce(sum(u."chargedCost"),0)::numeric*1000000)::bigint FROM "AiUsage" u WHERE (u."jobKind"='image_processing_attempt' AND u."jobId"=c.token::text) OR (u."jobId"=c.receipt::text AND u."jobKind" IN ('describe_image','identify_image','subject_lift') AND c.number=(SELECT max(older.number) FROM image_carry older WHERE older.receipt=c.receipt))),
 jsonb_build_object('retainedResult',c.result,'includesJobCost',c.number=(SELECT max(older.number) FROM image_carry older WHERE older.receipt=c.receipt),'standardCostMicros',(SELECT round(coalesce(sum(u."standardCost"),0)::numeric*1000000)::bigint FROM "AiUsage" u WHERE (u."jobKind"='image_processing_attempt' AND u."jobId"=c.token::text) OR (u."jobId"=c.receipt::text AND u."jobKind" IN ('describe_image','identify_image','subject_lift') AND c.number=(SELECT max(older.number) FROM image_carry older WHERE older.receipt=c.receipt))))::text
FROM image_carry c JOIN "ImageProcessingAttempt" a ON a.id=c.token;
--> statement-breakpoint
INSERT INTO "ImageEvidence" ("entityId","entityKind","inputHash",kind,value) SELECT j."imageId",'image',a."inputHash",'processed-image',a.output FROM "Answer" a JOIN image_carry c ON c.id=a."askId" JOIN "ImageProcessingJob" j ON j.id=c.receipt;
--> statement-breakpoint
INSERT INTO "ImageProcessingEvent" ("jobId","eventKey",event,details,"occurredAt")
SELECT a."jobId",a.id::text||':receipt:retained','execution.receipt',to_jsonb(a),coalesce(a."completedAt",a."startedAt") FROM "ImageProcessingAttempt" a ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "ImageProcessingJob" j SET "askId"=(SELECT c.id FROM image_carry c WHERE c.receipt=j.id ORDER BY c.number DESC LIMIT 1);
--> statement-breakpoint
CREATE TEMP TABLE image_owed AS
SELECT j.id,j."runId",j."attemptId",j."leaseUntil",j."runAt",j.failures,j."lastError",
 coalesce(a.executor->>'deviceId',CASE WHEN j.lane='cloud' THEN 'cloud' ELSE 'unassigned-device' END) AS executor,
 pg_temp.image_envelope(j.id,j."imageId",j."sourceContentHash",j."processorRevision",j.kind,j.lane,j.attempts) AS envelope
FROM "ImageProcessingJob" j LEFT JOIN "ImageProcessingAttempt" a ON a.id=j."attemptId"
WHERE j.state IN ('pending','leased','waiting_for_device') AND j."deletedAt" IS NULL;
--> statement-breakpoint
INSERT INTO "Ask" (id,"inputHash",feature,producer,"promptVersion",input,state,executor,"claimToken","sentAt","availableAt",attempts,"maxAttempts","lastError")
SELECT id,pg_temp.kernel_hash(envelope),envelope->>'feature','image','1',envelope,CASE WHEN "leaseUntil" IS NOT NULL THEN 'unknown' ELSE 'queued' END,
 CASE WHEN "leaseUntil" IS NOT NULL THEN executor ELSE 'external' END,CASE WHEN "leaseUntil" IS NOT NULL THEN "attemptId" END,CASE WHEN "leaseUntil" IS NOT NULL THEN now() END,"runAt",failures,greatest(5,failures+1),"lastError" FROM image_owed;
--> statement-breakpoint
UPDATE "ImageProcessingJob" j SET "askId"=o.id FROM image_owed o WHERE j.id=o.id;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey","runId")
SELECT a.id,'record','image:'||(a.input->'input'->>'imageId'),j."runId" FROM "Ask" a JOIN "ImageProcessingJob" j ON a.input->'input'->>'receiptId'=j.id::text ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey","runId")
SELECT a.id,'record','imageJob:'||j.id::text,j."runId" FROM "Ask" a JOIN "ImageProcessingJob" j ON a.input->'input'->>'receiptId'=j.id::text ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name,key,cursor,"runId","availableAt")
SELECT 'image.cloud',id::text,jsonb_build_object('jobId',id,'askId',id),"runId",CASE WHEN "leaseUntil" IS NULL THEN "runAt" ELSE now()+interval '6 hours' END FROM image_owed WHERE envelope->>'feature'='image.cloud' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey","runId")
SELECT id,'pass','image.cloud:'||id::text,"runId" FROM image_owed WHERE envelope->>'feature'='image.cloud' ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TEMP TABLE embedding_owed AS
SELECT s.*,jsonb_build_object('feature','entity.embedding','producer','embedding','tier',null,'model','text-embedding-3-small','parameters',jsonb_build_object('dimensions',1536),'outputRevision','1','promptVersion','1','input',jsonb_build_object('entityId',s."entityId",'entityKind',s."entityKind",'sourceHash',s."sourceHash",'text',s."semanticText")) AS envelope
FROM "SearchDocument" s WHERE s."deletedAt" IS NULL AND (s."embeddingDueAt" IS NOT NULL OR s."embeddingLeaseToken" IS NOT NULL);
--> statement-breakpoint
INSERT INTO "Ask" ("inputHash",feature,producer,"promptVersion",input,state,"sentAt","availableAt",attempts,"maxAttempts","lastError",executor,"claimToken")
SELECT pg_temp.kernel_hash(envelope),'entity.embedding','embedding','1',envelope,CASE WHEN "embeddingLeaseToken" IS NOT NULL THEN 'unknown' ELSE 'queued' END,CASE WHEN "embeddingLeaseToken" IS NOT NULL THEN now() END,coalesce("embeddingDueAt",now()),"embeddingAttempts",greatest(100,"embeddingAttempts"+1),"embeddingError",CASE WHEN "embeddingLeaseToken" IS NOT NULL THEN 'vectorize.lookup' END,"embeddingLeaseToken" FROM embedding_owed ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name,key,cursor,"availableAt")
SELECT 'vectorize.sync',"entityId"::text||':'||"sourceHash",jsonb_build_object('entityId',"entityId",'sourceHash',"sourceHash"),coalesce("embeddingDueAt",now()) FROM embedding_owed ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey")
SELECT a.id,'pass','vectorize.sync:'||o."entityId"::text||':'||o."sourceHash" FROM embedding_owed o JOIN "Ask" a ON a."inputHash"=pg_temp.kernel_hash(o.envelope) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey")
SELECT a.id,'record',o."entityKind"||':'||o."entityId"::text FROM embedding_owed o JOIN "Ask" a ON a."inputHash"=pg_temp.kernel_hash(o.envelope) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name,key,cursor,"availableAt") SELECT 'vectorize.sync','retired',null,now() WHERE EXISTS (SELECT 1 FROM "EntityEmbedding" WHERE "deletionId" IS NULL AND "artifactState"<>'selected' AND ("deletedAt" IS NOT NULL OR "artifactState" IN ('retired','failed'))) ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TEMP TABLE metadata_rows AS SELECT j.*,jsonb_build_object('feature','image.metadata','producer','image','tier',null,'model',null,'parameters',null,'outputRevision','1','promptVersion','1','input',jsonb_build_object('imageId',i.id,'key',i.key,'contentType',i."contentType",'sourceRevision',to_char(i."updatedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS envelope,i.id AS "imageId",i.key AS "sourceKey" FROM "Job" j JOIN "Image" i ON i.id::text=j.input->>'imageId' WHERE j.kind='image-metadata.extract' AND j.state NOT IN ('completed','failed','cancelled');

CREATE TEMP TABLE metadata_owed AS SELECT DISTINCT ON ("imageId","sourceKey") m.*,
 (SELECT min(other."availableAt") FROM metadata_rows other WHERE other."imageId"=m."imageId" AND other."sourceKey"=m."sourceKey") first_available
 FROM metadata_rows m ORDER BY "imageId","sourceKey",("leaseToken" IS NOT NULL) DESC,"updatedAt" DESC,id;
CREATE INDEX ON metadata_owed ("imageId","sourceKey");
ANALYZE metadata_owed;
--> statement-breakpoint
INSERT INTO "Ask" ("inputHash",feature,producer,"promptVersion",input,state,"availableAt","lastError") SELECT pg_temp.kernel_hash(envelope),'image.metadata','image','1',envelope,CASE WHEN "leaseToken" IS NOT NULL THEN 'unknown' ELSE 'queued' END,first_available,error FROM metadata_owed ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Pass" (name,key,cursor,"availableAt","runId") SELECT 'image.metadata',"imageId"::text||':'||"sourceKey",jsonb_build_object('imageId',"imageId"),first_available,"runId" FROM metadata_owed ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey","runId") SELECT a.id,'pass','image.metadata:'||m."imageId"::text||':'||m."sourceKey",m."runId" FROM metadata_owed m JOIN "Ask" a ON a."inputHash"=pg_temp.kernel_hash(m.envelope) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey","runId")
SELECT a.id,'run',m."runId"::text,m."runId" FROM metadata_rows m JOIN "Ask" a ON a."inputHash"=pg_temp.kernel_hash(m.envelope) WHERE m."runId" IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "ImageProcessingAttempt" a WHERE NOT EXISTS (SELECT 1 FROM "ImageProcessingEvent" e WHERE e."jobId"=a."jobId" AND e."eventKey"=a.id::text||':receipt:retained' AND e.details=to_jsonb(a))) THEN RAISE EXCEPTION 'Image receipt preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM image_carry c WHERE NOT EXISTS (SELECT 1 FROM "Answer" a WHERE a."inputHash"=pg_temp.kernel_hash(c.envelope) AND a."askId"=c.id AND a.output->'outcome'=c.result)) THEN RAISE EXCEPTION 'Image result preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM image_owed o WHERE NOT EXISTS (SELECT 1 FROM "Ask" a WHERE a.id=o.id AND a.state=CASE WHEN o."leaseUntil" IS NULL THEN 'queued' ELSE 'unknown' END)) THEN RAISE EXCEPTION 'Image work preservation mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM metadata_rows m WHERE NOT EXISTS(SELECT 1 FROM "Ask" a WHERE a."inputHash"=pg_temp.kernel_hash(m.envelope))) THEN RAISE EXCEPTION 'Image metadata source preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM embedding_owed o WHERE NOT EXISTS (SELECT 1 FROM "Ask" a WHERE a."inputHash"=pg_temp.kernel_hash(o.envelope))) THEN RAISE EXCEPTION 'Embedding work preservation mismatch'; END IF;
END $$;
--> statement-breakpoint
DELETE FROM "Job" WHERE kind='image-metadata.extract';

--> statement-breakpoint

DROP TABLE "ImageProcessingAttempt";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "deletionRetryAt";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "deletionAttempts";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "deletionError";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "deletionFailingSince";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingDueAt";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingGeneration";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingLeaseToken";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingLeaseUntil";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingAttempts";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingError";--> statement-breakpoint
ALTER TABLE "SearchDocument" DROP COLUMN "embeddingFailingSince";