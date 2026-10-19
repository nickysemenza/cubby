CREATE TABLE "AutomaticRule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family" text NOT NULL,
	"ruleKey" text NOT NULL,
	"revision" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabledAt" timestamp,
	"enabledByUserId" text,
	"enabledReason" text,
	"disabledAt" timestamp,
	"disabledReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "AutomaticRule_family_check" CHECK ("AutomaticRule"."family" IN ('field', 'statement_transaction')),
	CONSTRAINT "AutomaticRule_key_check" CHECK ("AutomaticRule"."ruleKey" IN ('field.addition', 'statement_transaction.attach') AND starts_with("AutomaticRule"."ruleKey", "AutomaticRule"."family" || '.'))
);
--> statement-breakpoint
CREATE TABLE "RunStep" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"childRunId" uuid,
	"cursor" jsonb,
	"pausedReason" text,
	"pausedUntil" timestamp,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb,
	"startedAt" timestamp,
	"endedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunStep_state_check" CHECK ("RunStep"."state" IN ('queued', 'running', 'waiting', 'paused', 'done', 'failed')),
	CONSTRAINT "RunStep_counts_check" CHECK ("RunStep"."found" >= 0 AND "RunStep"."done" >= 0 AND "RunStep"."failed" >= 0 AND "RunStep"."skipped" >= 0 AND "RunStep"."pages" >= 0)
);
--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "metadataOutcome" text;--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "metadataError" text;--> statement-breakpoint
ALTER TABLE "AutomaticRule" ADD CONSTRAINT "AutomaticRule_enabledByUserId_user_id_fk" FOREIGN KEY ("enabledByUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_childRunId_Run_id_fk" FOREIGN KEY ("childRunId") REFERENCES "public"."Run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "AutomaticRule_family_key" ON "AutomaticRule" USING btree ("family","ruleKey");--> statement-breakpoint
CREATE UNIQUE INDEX "RunStep_run_key" ON "RunStep" USING btree ("runId","key");--> statement-breakpoint
CREATE INDEX "RunStep_child_idx" ON "RunStep" USING btree ("childRunId") WHERE "RunStep"."childRunId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_maintenance" ON "Run" USING btree ("purpose") WHERE "Run"."purpose" = 'maintenance' AND "Run"."status" IN ('running', 'paused_auth');--> statement-breakpoint
ALTER TABLE "Image" ADD CONSTRAINT "Image_metadataOutcome_check" CHECK ("Image"."metadataOutcome" IN ('original_missing', 'extraction_failed'));--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'suggestion_sweep', 'ai_refresh', 'background', 'file_import', 'mail_search', 'mail_discovery', 'mail_reclassify', 'maintenance', 'sweep'));--> statement-breakpoint
-- The field Sweep's existing confident-Addition auto-apply carries forward as
-- an enabled Automatic rule; statement attach starts off until member-reviewed
-- matches make it eligible (ADR 0016 amendment).
INSERT INTO "AutomaticRule" ("family", "ruleKey", "revision", "enabled", "enabledAt", "enabledByUserId", "enabledReason", "disabledAt", "disabledReason")
VALUES
  ('field', 'field.addition', '2026-10-18.1', true, now(), NULL, 'Migration 0091: carries the field Sweep''s existing confident-Addition auto-apply forward as an Automatic rule', NULL, NULL),
  ('statement_transaction', 'statement_transaction.attach', '2026-10-18.3/2026-10-17.1', false, NULL, NULL, NULL, now(), 'Migration 0091: starts off until member-reviewed matches show it is eligible')
ON CONFLICT ("family", "ruleKey") DO NOTHING;
