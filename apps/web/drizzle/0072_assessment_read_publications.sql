CREATE TABLE "AssessmentReadDependency" (
	"assessmentId" uuid NOT NULL,
	"sourceKind" text NOT NULL,
	"sourceId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadFact" (
	"assessmentId" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"family" text NOT NULL,
	"key" jsonb NOT NULL,
	"filters" jsonb NOT NULL,
	"row" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadMembership" (
	"assessmentId" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"entity" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"stateFamily" text NOT NULL,
	"retained" boolean NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "AssessmentReadMembership_kind_check" CHECK ("AssessmentReadMembership"."kind" IN ('scope', 'ref')),
	CONSTRAINT "AssessmentReadMembership_ordinal_check" CHECK ("AssessmentReadMembership"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadPublication" (
	"assessmentId" uuid PRIMARY KEY NOT NULL,
	"revision" uuid NOT NULL,
	"rulesVersion" integer NOT NULL,
	"contentHash" text NOT NULL,
	"groupKey" text NOT NULL,
	"admitted" boolean NOT NULL,
	"computedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadStage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"componentKey" text NOT NULL,
	"groups" jsonb NOT NULL,
	"assessmentIds" uuid[] NOT NULL,
	"tickets" jsonb NOT NULL,
	"revision" uuid NOT NULL,
	"nextIndex" integer DEFAULT 0 NOT NULL,
	"rulesVersion" integer NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AssessmentReadStage_progress_check" CHECK (cardinality("AssessmentReadStage"."assessmentIds") > 0 AND "AssessmentReadStage"."nextIndex" >= 0 AND "AssessmentReadStage"."nextIndex" <= cardinality("AssessmentReadStage"."assessmentIds"))
);
--> statement-breakpoint
CREATE TABLE "AssessmentReadStageResult" (
	"stageId" uuid NOT NULL,
	"assessmentId" uuid NOT NULL,
	"groupKey" text NOT NULL,
	"contentHash" text NOT NULL,
	"admitted" boolean NOT NULL,
	"dependencies" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "WorkItem" ADD COLUMN "fanoutAfter" uuid;--> statement-breakpoint
ALTER TABLE "AssessmentReadDependency" ADD CONSTRAINT "AssessmentReadDependency_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadFact" ADD CONSTRAINT "AssessmentReadFact_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadMembership" ADD CONSTRAINT "AssessmentReadMembership_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadPublication" ADD CONSTRAINT "AssessmentReadPublication_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadStageResult" ADD CONSTRAINT "AssessmentReadStageResult_stageId_AssessmentReadStage_id_fk" FOREIGN KEY ("stageId") REFERENCES "public"."AssessmentReadStage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentReadStageResult" ADD CONSTRAINT "AssessmentReadStageResult_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadDependency_source_key" ON "AssessmentReadDependency" USING btree ("assessmentId","sourceKind","sourceId");--> statement-breakpoint
CREATE INDEX "AssessmentReadDependency_reverse_idx" ON "AssessmentReadDependency" USING btree ("sourceId","sourceKind","assessmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadFact_revision_family_key" ON "AssessmentReadFact" USING btree ("assessmentId","revision","family");--> statement-breakpoint
CREATE INDEX "AssessmentReadFact_family_idx" ON "AssessmentReadFact" USING btree ("family","assessmentId","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadMembership_revision_ordinal_key" ON "AssessmentReadMembership" USING btree ("assessmentId","revision","kind","ordinal");--> statement-breakpoint
CREATE INDEX "AssessmentReadMembership_entity_idx" ON "AssessmentReadMembership" USING btree ("kind","entity","assessmentId","revision");--> statement-breakpoint
CREATE INDEX "AssessmentReadMembership_value_idx" ON "AssessmentReadMembership" USING btree ("kind",md5("value"),"assessmentId","revision");--> statement-breakpoint
CREATE INDEX "AssessmentReadPublication_group_idx" ON "AssessmentReadPublication" USING btree ("groupKey");--> statement-breakpoint
CREATE INDEX "AssessmentReadPublication_rules_idx" ON "AssessmentReadPublication" USING btree ("rulesVersion");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadStage_component_key" ON "AssessmentReadStage" USING btree ("componentKey");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadStage_revision_key" ON "AssessmentReadStage" USING btree ("revision");--> statement-breakpoint
CREATE UNIQUE INDEX "AssessmentReadStageResult_member_key" ON "AssessmentReadStageResult" USING btree ("stageId","assessmentId");--> statement-breakpoint
CREATE INDEX "AssessmentState_active_suppression_idx" ON "AssessmentState" USING btree ("entity","recordId") WHERE "AssessmentState"."active" AND "AssessmentState"."suppression" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[], p_reason text DEFAULT 'Refresh requested') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "WorkItem" (target, ref, priority, reason)
    SELECT DISTINCT p_target, r,
      CASE current_setting('cubby.derived_priority', true) WHEN '1' THEN 1 ELSE 0 END, p_reason
    FROM unnest(p_refs) AS r WHERE r IS NOT NULL
  ON CONFLICT (target, ref) DO UPDATE SET
    reason = EXCLUDED.reason,
    ticket = nextval('"WorkTicket"'),
    priority = LEAST("WorkItem".priority, EXCLUDED.priority),
    "readyAt" = now(),
    attempts = 0,
    "lastError" = NULL,
    "waitCause" = NULL,
    "waitStartedAt" = NULL,
    "fanoutAfter" = NULL;
  IF current_setting('cubby.derived_capture', true) IS DISTINCT FROM txid_current()::text THEN
    INSERT INTO "JobInvalidationCapture" (key, "capturedAt")
      VALUES ('derived:drain', now() AT TIME ZONE 'UTC');
    PERFORM set_config('cubby.derived_capture', txid_current()::text, true);
  END IF;
END $$;
