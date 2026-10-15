CREATE TABLE "Assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publicationKey" text NOT NULL,
	"family" text NOT NULL,
	"subject" jsonb NOT NULL,
	"judgment" jsonb NOT NULL,
	"fingerprint" text,
	"producer" jsonb,
	"evidence" jsonb,
	"origin" jsonb,
	"served" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AssessmentState" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid,
	"entity" text NOT NULL,
	"recordId" uuid NOT NULL,
	"field" text DEFAULT '' NOT NULL,
	"financeReviewFingerprint" text,
	"evaluationId" uuid,
	"provenance" jsonb,
	"acceptanceReceipt" jsonb,
	"supersessionReceipt" jsonb,
	"currentValue" jsonb,
	"suggestedValue" jsonb DEFAULT 'null'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"runnerUpValue" jsonb,
	"runnerUpConfidence" real,
	"model" text DEFAULT 'unknown' NOT NULL,
	"pairKey" uuid,
	"kind" text DEFAULT 'addition' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"correctValue" jsonb,
	"family" text DEFAULT 'field' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text,
	"confirmedValue" jsonb,
	"suppression" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AssessmentState_kind_check" CHECK ("AssessmentState"."kind" IN ('correction', 'addition')),
	CONSTRAINT "AssessmentState_status_check" CHECK ("AssessmentState"."status" IN ('pending', 'applied', 'rejected', 'superseded', 'resolved')),
	CONSTRAINT "AssessmentState_confidence_check" CHECK ("AssessmentState"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "Feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessmentId" uuid NOT NULL,
	"operationId" text NOT NULL,
	"verdict" text NOT NULL,
	"correction" jsonb NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"intent" text NOT NULL,
	"authority" text NOT NULL,
	"actorUserId" text,
	"suppression" jsonb,
	"receipt" jsonb,
	"metadata" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Feedback_verdict_check" CHECK ("Feedback"."verdict" IN ('correct', 'wrong', 'uncertain', 'dismissed', 'ungraded')),
	CONSTRAINT "Feedback_authority_check" CHECK ("Feedback"."authority" IN ('member', 'evaluation', 'automatic', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "AssessmentState" ADD CONSTRAINT "AssessmentState_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentState" ADD CONSTRAINT "AssessmentState_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."AiEvaluation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AssessmentState" ADD CONSTRAINT "AssessmentState_history_fk" FOREIGN KEY ("id") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_assessmentId_Assessment_id_fk" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "Assessment_publication_key" ON "Assessment" USING btree ("publicationKey");--> statement-breakpoint
CREATE INDEX "Assessment_family_idx" ON "Assessment" USING btree ("family","createdAt");--> statement-breakpoint
CREATE INDEX "AssessmentState_family_active_idx" ON "AssessmentState" USING btree ("family","active","status");--> statement-breakpoint
CREATE INDEX "AssessmentState_run_status_idx" ON "AssessmentState" USING btree ("runId","status");--> statement-breakpoint
CREATE INDEX "AssessmentState_evaluation_idx" ON "AssessmentState" USING btree ("evaluationId");--> statement-breakpoint
CREATE INDEX "AssessmentState_entity_field_status_idx" ON "AssessmentState" USING btree ("entity","field","status");--> statement-breakpoint
CREATE INDEX "AssessmentState_entity_record_status_idx" ON "AssessmentState" USING btree ("entity","recordId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "Feedback_operation_key" ON "Feedback" USING btree ("assessmentId","operationId");--> statement-breakpoint
CREATE INDEX "Feedback_assessment_idx" ON "Feedback" USING btree ("assessmentId","createdAt");