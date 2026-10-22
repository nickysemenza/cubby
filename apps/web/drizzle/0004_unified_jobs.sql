CREATE TABLE "Job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"runId" uuid,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"cursor" jsonb,
	"result" jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"availableAt" timestamp DEFAULT now() NOT NULL,
	"leaseToken" uuid,
	"leaseExpiresAt" timestamp,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Job_state_check" CHECK ("Job"."state" IN ('queued','running','retry_wait','paused','completed','failed','cancelled')),
	CONSTRAINT "Job_attempts_check" CHECK ("Job"."attempts" >= 0 AND "Job"."maxAttempts" > 0)
);
--> statement-breakpoint
ALTER TABLE "Assessment" ADD COLUMN "projection" jsonb;--> statement-breakpoint
ALTER TABLE "AssessmentState" ADD COLUMN "ledgerPartyId" uuid;--> statement-breakpoint
ALTER TABLE "Feedback" ADD COLUMN "projection" jsonb;--> statement-breakpoint
-- The writer barrier is documented in the production migration runbook.
-- Locks make the copy/drop boundary atomic even if a stale writer slips through.
LOCK TABLE "Assessment", "AssessmentState", "Feedback", "RunFinding", "EmailAccuracyEvaluation",
  "AiEvaluation", "AiEvaluationRequest", "EntityEmbedding", "ImageProcessingJob", "Run", "RunStep",
  "DerivedDiscoveryPass", "DerivedRefreshCaptureInbox", "DerivedRefreshCursor", "DerivedRefreshFailure",
  "DerivedRefreshObservedInput", "DerivedRefreshPublication", "DerivedRefreshRevision", "DerivedRefreshScope",
  "DerivedRefreshSnapshot", "DerivedRefreshWork", "Job" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "Assessment_immutable" ON "Assessment";
DROP TRIGGER IF EXISTS "Feedback_immutable" ON "Feedback";
DROP FUNCTION IF EXISTS "assessment_history_immutable"();
DROP TRIGGER IF EXISTS "Email_assessment_lifecycle" ON "Email";
DROP TRIGGER IF EXISTS "OrderMailEvent_assessment_lifecycle" ON "OrderMailEvent";
DROP FUNCTION IF EXISTS "assessment_mail_lifecycle"();
DROP TRIGGER IF EXISTS "EntityLink_live_endpoints" ON "EntityLink";
DROP FUNCTION IF EXISTS "entity_link_require_live_endpoints"();
DO $$ DECLARE target record; BEGIN
  FOR target IN SELECT t.tgname, c.relname FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND t.tgname IN ('Entity_identity_insert','Entity_identity_soft_delete','Entity_identity_delete')
  LOOP EXECUTE format('DROP TRIGGER %I ON public.%I', target.tgname, target.relname); END LOOP;
END $$;
DROP FUNCTION IF EXISTS "entity_identity_on_insert"();
DROP FUNCTION IF EXISTS "entity_identity_on_soft_delete"();
DROP FUNCTION IF EXISTS "entity_identity_on_delete"();
--> statement-breakpoint
-- Preserve trial provenance, then hide the unserved candidate before snapshotting.
UPDATE "Assessment" a SET origin=coalesce(a.origin,'{}'::jsonb) || jsonb_build_object('trialPairKey',s."pairKey")
  FROM "AssessmentState" s WHERE s.id=a.id AND s."pairKey" IS NOT NULL;
UPDATE "AssessmentState" s SET active=false,status='superseded'
  FROM "Assessment" a WHERE a.id=s.id AND NOT a.served AND s.status='pending';
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,projection,"createdAt")
  SELECT s.id,'legacy-projection','ungraded','{"present":false}'::jsonb,'projection','unknown',
    to_jsonb(s)-ARRAY['id','family','createdAt','updatedAt','pairKey'],s."updatedAt" FROM "AssessmentState" s;
--> statement-breakpoint
-- One canonical publication per evidence tuple prevents a resolved finding reopening.
WITH ranked AS (
 SELECT f.*,row_number() OVER (PARTITION BY "ledgerPartyId","entityKind","entityId",kind,"evidenceFingerprint"
   ORDER BY (status='open') DESC,"createdAt" DESC,id DESC) AS rank FROM "RunFinding" f
)
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,fingerprint,producer,origin,"createdAt")
SELECT id,CASE WHEN rank=1 THEN 'run_finding:v1:' || "ledgerPartyId" || ':' || "entityKind" || ':' || "entityId" || ':' || kind || ':' || "evidenceFingerprint"
  ELSE 'run_finding:legacy:' || id END,'run_finding',
  jsonb_build_object('kind','run_finding','entity',"entityKind",'recordId',"entityId",'ledgerPartyId',"ledgerPartyId"),
  jsonb_build_object('kind',kind,'summary',summary,'proposedFix',"proposedFix",'probability',probability),"evidenceFingerprint",
  CASE WHEN "runId" IS NULL THEN NULL ELSE jsonb_build_object('kind','rule','model',NULL,'revision',NULL,'runId',"runId",'evaluationId',NULL) END,
  jsonb_build_object('table','RunFinding','id',id,'autoApplied',"autoApplied",'expiresAt',"expiresAt"),"createdAt" FROM ranked;
INSERT INTO "AssessmentState" (id,"runId","ledgerPartyId",entity,"recordId",family,status,data,fingerprint,"createdAt","updatedAt")
 SELECT id,"runId","ledgerPartyId","entityKind","entityId",'run_finding',
   CASE status WHEN 'open' THEN 'pending' WHEN 'applied' THEN 'applied' ELSE 'rejected' END,
   jsonb_build_object('kind',kind,'summary',summary,'proposedFix',"proposedFix",'probability',probability,'expiresAt',"expiresAt"),
   "evidenceFingerprint","createdAt","updatedAt" FROM "RunFinding";
UPDATE "Assessment" a SET projection=to_jsonb(s)-ARRAY['id','family','createdAt','updatedAt','pairKey']
 FROM "AssessmentState" s WHERE s.id=a.id AND a.family='run_finding';
INSERT INTO "Feedback" ("assessmentId","operationId",verdict,correction,intent,authority,"actorUserId",receipt,metadata,"createdAt")
 SELECT id,'legacy-resolution',CASE status WHEN 'applied' THEN 'correct' ELSE 'dismissed' END,
 '{"present":false}'::jsonb,CASE status WHEN 'applied' THEN 'apply' ELSE 'history' END,
 CASE WHEN "resolvedByUserId" IS NOT NULL THEN 'member' WHEN "autoApplied" THEN 'automatic' ELSE 'unknown' END,
 "resolvedByUserId",CASE WHEN status='applied' THEN '{"legacy":true}'::jsonb ELSE NULL END,
 CASE WHEN "autoApplied" THEN '{"policy":"import"}'::jsonb ELSE NULL END,coalesce("resolvedAt","updatedAt")
 FROM "RunFinding" WHERE status<>'open';
INSERT INTO "Assessment" (id,"publicationKey",family,subject,judgment,evidence,origin,served,"createdAt")
 SELECT id,'evaluation_sample:email_accuracy:' || id,'evaluation_sample',
 jsonb_build_object('kind','evaluation_sample','evaluation','email_accuracy','ownerUserId',"ownerUserId"),roster,
 jsonb_build_object('requestedSampleSize',"requestedSampleSize",'populationCount',"populationCount",'sampleSize',"sampleSize"),
 jsonb_build_object('table','EmailAccuracyEvaluation','id',id),false,"createdAt" FROM "EmailAccuracyEvaluation";
--> statement-breakpoint
INSERT INTO "Job" (key,kind,input,state,result,"createdAt","updatedAt")
 SELECT 'ai-evaluation:' || id,'ai.evaluation',jsonb_build_object('evaluationId',id),'queued',
 jsonb_build_object('legacyExecution',jsonb_build_object('attempts',attempts,'attemptToken',"attemptToken",'runAttempt',"runAttempt",'deadlineAt',"deadlineAt",'nextAttemptAt',"nextAttemptAt")),"createdAt","updatedAt"
 FROM "AiEvaluation" WHERE state IN ('queued','running','retry_wait','result_ready');
INSERT INTO "Job" (key,kind,"runId",input,state,error,result,"createdAt","updatedAt")
 SELECT 'image-processing:' || id,'image.processing',"runId",jsonb_build_object('processingId',id),
 CASE WHEN "deletedAt" IS NOT NULL THEN 'cancelled' WHEN state='failed' THEN 'failed' ELSE 'queued' END,"lastError",
 jsonb_build_object('legacyExecution',jsonb_build_object('attemptId',"attemptId",'attempts',attempts,'failuresSinceRetry',"failuresSinceRetry",'leaseExpiresAt',"leaseExpiresAt",'nextAttemptAt',"nextAttemptAt")),"createdAt","updatedAt"
 FROM "ImageProcessingJob" WHERE state IN ('pending','leased','waiting_for_device','failed');
WITH candidates AS (
 SELECT e.*,row_number() OVER (PARTITION BY "entityKind","entityId","embeddingHash"
   ORDER BY ("artifactState"<>'retired') DESC,("artifactState" IN ('prepared','submitting','submitted')) DESC,"updatedAt" DESC,id DESC) AS rank
 FROM "EntityEmbedding" e WHERE "artifactState" IN ('prepared','submitting','submitted','failed','retired')
)
INSERT INTO "Job" (id,key,kind,input,state,cursor,error,result,"createdAt","updatedAt")
 SELECT id,'embedding:' || "entityKind" || ':' || "entityId" || ':' || "embeddingHash" || CASE WHEN rank=1 AND "artifactState"<>'retired' THEN '' ELSE ':retired:' || id END,
 'embedding.refresh',jsonb_build_object('entityKind',"entityKind",'entityId',"entityId",'hash',"embeddingHash",'text',"embeddingText",
 'config',jsonb_build_object('provider',provider,'model',model,'dimensions',dimensions)),
 CASE WHEN "artifactState"='failed' THEN 'failed' WHEN "artifactState"='retired' THEN 'cancelled' ELSE 'queued' END,
 CASE WHEN "submissionId" IS NOT NULL AND "vectorHash" IS NOT NULL THEN
 jsonb_build_object('hash',"vectorHash",'mutationId',"submissionId",'submittedAt',"updatedAt") ELSE NULL END,
 "lastError",jsonb_build_object('legacyArtifact',to_jsonb(candidates)-'rank'),"createdAt","updatedAt" FROM candidates;
INSERT INTO "Job" (key,kind,input) SELECT 'refresh:' || family,'refresh.family',jsonb_build_object('family',family)
 FROM unnest(ARRAY['search','recipes','conversions','embeddings','orphans']) family;
INSERT INTO "Job" (key,kind,input) VALUES ('discovery:connections','discovery.connections','{}');
INSERT INTO "Job" (key,kind,"runId",input,state,error,result,"createdAt","updatedAt")
 SELECT 'run:' || id,'run.execute',id,jsonb_build_object('runId',id,'purpose',purpose),
 CASE WHEN status IN ('paused','paused_auth','paused_offline','needs_review') THEN 'paused'
 WHEN status IN ('failed','dispatch_failed') THEN 'failed' ELSE 'queued' END,"dispatchError",
 jsonb_build_object('legacyExecution',jsonb_build_object('status',status,'progress',progress,'dispatchError',"dispatchError")),"createdAt","updatedAt"
 FROM "Run" WHERE purpose IN ('mail_discovery','ai_refresh','mail_reclassify','suggestion_sweep','maintenance','sweep')
 AND status<>'completed' AND "deletedAt" IS NULL;
-- The retired purpose cannot be resumed; broad family Jobs replace its execution.
-- Its original diagnostics remain in the Run and the terminal Job receipt.
INSERT INTO "Job" (key,kind,"runId",input,state,error,result,"createdAt","updatedAt")
 SELECT 'retired-derived-run:' || id,'refresh.family',id,'{"family":"search"}','cancelled',"dispatchError",
 jsonb_build_object('legacyExecution',jsonb_build_object('purpose',purpose,'status',status,'progress',progress,'dispatchError',"dispatchError")),"createdAt","updatedAt"
 FROM "Run" WHERE purpose='derived_refresh' AND status<>'completed';
UPDATE "Run" SET status='failed',"endedAt"=coalesce("endedAt",now()),
 "failureCode"='retired_execution',"dispatchError"=concat_ws(E'\n',"dispatchError",'Incremental refresh execution replaced by broad Job families')
 WHERE purpose='derived_refresh' AND status NOT IN ('completed','failed','dispatch_failed');
-- Keep raw retired refresh diagnostics as terminal history, separate from repair work.
INSERT INTO "Job" (key,kind,input,state,error,result)
 SELECT 'refresh:legacy-diagnostics','refresh.family','{"family":"search"}','cancelled','Retired incremental refresh diagnostics',
 jsonb_build_object('legacyRefresh',jsonb_build_object(
 'failures',(SELECT coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) FROM "DerivedRefreshFailure" f),
 'work',(SELECT coalesce(jsonb_agg(to_jsonb(w)),'[]'::jsonb) FROM "DerivedRefreshWork" w WHERE "lastError" IS NOT NULL)))
 WHERE EXISTS(SELECT 1 FROM "DerivedRefreshFailure") OR EXISTS(SELECT 1 FROM "DerivedRefreshWork" WHERE "lastError" IS NOT NULL);
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "RunFinding" f LEFT JOIN "Assessment" a ON a.id=f.id LEFT JOIN "AssessmentState" s ON s.id=f.id WHERE a.id IS NULL OR s.id IS NULL)
 OR EXISTS (SELECT 1 FROM "EmailAccuracyEvaluation" e LEFT JOIN "Assessment" a ON a.id=e.id WHERE a.id IS NULL)
 OR EXISTS (SELECT 1 FROM "AiEvaluation" e LEFT JOIN "Job" j ON j.key='ai-evaluation:' || e.id WHERE e.state IN ('queued','running','retry_wait','result_ready') AND j.id IS NULL)
 OR EXISTS (SELECT 1 FROM "ImageProcessingJob" p LEFT JOIN "Job" j ON j.key='image-processing:' || p.id WHERE p.state IN ('pending','leased','waiting_for_device','failed') AND j.id IS NULL)
 OR EXISTS (SELECT 1 FROM "EntityEmbedding" e LEFT JOIN "Job" j ON j.id=e.id WHERE e."artifactState" IN ('prepared','submitting','submitted','failed','retired') AND j.id IS NULL)
 OR EXISTS (SELECT 1 FROM "Run" r LEFT JOIN "Job" j ON j.key='run:' || r.id WHERE r.purpose IN ('mail_discovery','ai_refresh','mail_reclassify','suggestion_sweep','maintenance','sweep') AND r.status<>'completed' AND r."deletedAt" IS NULL AND j.id IS NULL)
 OR EXISTS (SELECT 1 FROM "Run" r LEFT JOIN "Job" j ON j.key='retired-derived-run:' || r.id WHERE r.purpose='derived_refresh' AND r.status<>'completed' AND j.id IS NULL)
 THEN RAISE EXCEPTION 'Unified Job cutover refused: retained source has no destination'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "DerivedDiscoveryPass" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshCaptureInbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshCursor" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshFailure" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshObservedInput" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshPublication" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshRevision" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshScope" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshSnapshot" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "DerivedRefreshWork" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "EmailAccuracyEvaluation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "RunFinding" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "DerivedDiscoveryPass" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshCaptureInbox" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshCursor" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshFailure" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshObservedInput" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshPublication" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshRevision" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshScope" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshSnapshot" CASCADE;--> statement-breakpoint
DROP TABLE "DerivedRefreshWork" CASCADE;--> statement-breakpoint
DROP TABLE "EmailAccuracyEvaluation" CASCADE;--> statement-breakpoint
DROP TABLE "RunFinding" CASCADE;--> statement-breakpoint
ALTER TABLE "Feedback" DROP CONSTRAINT "Feedback_authority_check";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP CONSTRAINT "ImageProcessingJob_lease_check";--> statement-breakpoint
DROP INDEX "EntityEmbedding_recovery_idx";--> statement-breakpoint
DROP INDEX "ImageProcessingJob_dispatch_idx";--> statement-breakpoint
DROP INDEX "AiEvaluation_admission_idx";--> statement-breakpoint
DROP INDEX "AiEvaluation_run_state_idx";--> statement-breakpoint
ALTER TABLE "Job" ADD CONSTRAINT "Job_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "Job_key_unique" ON "Job" USING btree ("key");--> statement-breakpoint
CREATE INDEX "Job_due_idx" ON "Job" USING btree ("state","availableAt","priority");--> statement-breakpoint
CREATE INDEX "Job_run_idx" ON "Job" USING btree ("runId");--> statement-breakpoint
ALTER TABLE "AssessmentState" ADD CONSTRAINT "AssessmentState_ledgerPartyId_LedgerParty_id_fk" FOREIGN KEY ("ledgerPartyId") REFERENCES "public"."LedgerParty"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AssessmentState_ledger_party_idx" ON "AssessmentState" USING btree ("ledgerPartyId","family","status");--> statement-breakpoint
CREATE INDEX "AiEvaluation_admission_idx" ON "AiEvaluation" USING btree ("executionKind","state");--> statement-breakpoint
CREATE INDEX "AiEvaluation_run_state_idx" ON "AiEvaluation" USING btree ("runId","state");--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "availableAt";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "leaseToken";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "leaseExpiresAt";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "visibilityAttempts";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" DROP COLUMN "lastError";--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP COLUMN "runAttempt";--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP COLUMN "attemptToken";--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP COLUMN "deadlineAt";--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP COLUMN "nextAttemptAt";--> statement-breakpoint
ALTER TABLE "AssessmentState" DROP COLUMN "pairKey";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP COLUMN "failuresSinceRetry";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP COLUMN "nextAttemptAt";--> statement-breakpoint
ALTER TABLE "ImageProcessingJob" DROP COLUMN "leaseExpiresAt";--> statement-breakpoint
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_system_check" CHECK ("Feedback"."authority" <> 'system' OR ("Feedback"."actorUserId" IS NULL AND "Feedback"."verdict" = 'ungraded' AND "Feedback"."suppression" IS NULL));--> statement-breakpoint
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_authority_check" CHECK ("Feedback"."authority" IN ('member', 'evaluation', 'automatic', 'unknown', 'system'));