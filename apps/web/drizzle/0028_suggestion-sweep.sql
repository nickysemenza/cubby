CREATE TABLE "Suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"entity" text NOT NULL,
	"recordId" uuid NOT NULL,
	"field" text NOT NULL,
	"currentValue" jsonb,
	"suggestedValue" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"runnerUpValue" jsonb,
	"runnerUpConfidence" real,
	"model" text NOT NULL,
	"pairKey" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"correctValue" jsonb,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Suggestion_kind_check" CHECK ("Suggestion"."kind" IN ('correction', 'addition')),
	CONSTRAINT "Suggestion_status_check" CHECK ("Suggestion"."status" IN ('pending', 'applied', 'rejected')),
	CONSTRAINT "Suggestion_confidence_check" CHECK ("Suggestion"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Suggestion_run_status_idx" ON "Suggestion" USING btree ("runId","status");--> statement-breakpoint
CREATE INDEX "Suggestion_entity_field_status_idx" ON "Suggestion" USING btree ("entity","field","status");--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'suggestion_sweep', 'background', 'file_import', 'mail_search', 'mail_discovery'));