CREATE TABLE "AiEvaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"workKey" text NOT NULL,
	"feature" text NOT NULL,
	"target" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"runAttempt" integer DEFAULT 0 NOT NULL,
	"attemptToken" uuid,
	"deadlineAt" timestamp,
	"nextAttemptAt" timestamp,
	"result" jsonb,
	"receipt" jsonb,
	"error" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AiEvaluation_state_check" CHECK ("AiEvaluation"."state" IN ('queued','running','result_ready','retry_wait','completed','blocked','failed','obsolete','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD COLUMN "evaluationId" uuid;--> statement-breakpoint
ALTER TABLE "Suggestion" ADD COLUMN "evaluationId" uuid;--> statement-breakpoint
ALTER TABLE "Suggestion" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "Suggestion" ADD COLUMN "acceptanceReceipt" jsonb;--> statement-breakpoint
ALTER TABLE "Suggestion" ADD COLUMN "supersessionReceipt" jsonb;--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD CONSTRAINT "AiEvaluation_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluation_work_key" ON "AiEvaluation" USING btree ("workKey");--> statement-breakpoint
CREATE INDEX "AiEvaluation_run_state_idx" ON "AiEvaluation" USING btree ("runId","state","nextAttemptAt");--> statement-breakpoint
CREATE INDEX "AiEvaluation_feature_idx" ON "AiEvaluation" USING btree ("feature");--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" ADD CONSTRAINT "EmailClassificationObservation_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."AiEvaluation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_evaluationId_AiEvaluation_id_fk" FOREIGN KEY ("evaluationId") REFERENCES "public"."AiEvaluation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EmailClassificationObservation_evaluation_idx" ON "EmailClassificationObservation" USING btree ("evaluationId");--> statement-breakpoint
CREATE INDEX "Suggestion_evaluation_idx" ON "Suggestion" USING btree ("evaluationId");--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'suggestion_sweep', 'ai_refresh', 'background', 'file_import', 'mail_search', 'mail_discovery'));