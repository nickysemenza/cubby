CREATE TABLE "AiEvaluationRequest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"evaluationId" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"cancelledAt" timestamp,
	"receipt" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_status_check";--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN "shareKey" text;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN "executionKind" text DEFAULT 'ai_refresh' NOT NULL;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD COLUMN "restarts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "AiEvaluationRequest" ADD CONSTRAINT "AiEvaluationRequest_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AiEvaluationRequest" ADD CONSTRAINT "AiEvaluationRequest_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."AiEvaluation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluationRequest_run_item_key" ON "AiEvaluationRequest" USING btree ("runId","evaluationId");--> statement-breakpoint
CREATE INDEX "AiEvaluationRequest_evaluation_idx" ON "AiEvaluationRequest" USING btree ("evaluationId");--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluation_pending_share_key" ON "AiEvaluation" USING btree ("shareKey") WHERE "AiEvaluation"."shareKey" IS NOT NULL AND "AiEvaluation"."state" IN ('queued','running','result_ready','retry_wait');--> statement-breakpoint
CREATE INDEX "AiEvaluation_admission_idx" ON "AiEvaluation" USING btree ("executionKind","state","deadlineAt");--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD CONSTRAINT "AiEvaluation_execution_kind_check" CHECK ("AiEvaluation"."executionKind" IN ('ai_refresh','mail_reclassify','suggestion_sweep'));--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_status_check" CHECK ("Run"."status" IN ('running', 'paused', 'paused_auth', 'paused_offline', 'paused_approval', 'needs_review', 'completed', 'failed', 'dispatch_failed'));--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'suggestion_sweep', 'ai_refresh', 'background', 'file_import', 'mail_search', 'mail_discovery', 'mail_reclassify'));