CREATE TABLE "RunPushRegistration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"deviceId" uuid NOT NULL,
	"kind" text NOT NULL,
	"pushToken" text NOT NULL,
	"apnsEnvironment" text NOT NULL,
	"appIdentity" text NOT NULL,
	"lastStateKey" text,
	"lastSentAt" timestamp,
	"lastError" text,
	"endedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunPushRegistration_kind_check" CHECK ("RunPushRegistration"."kind" IN ('live_activity', 'alert')),
	CONSTRAINT "RunPushRegistration_environment_check" CHECK ("RunPushRegistration"."apnsEnvironment" IN ('development', 'production')),
	CONSTRAINT "RunPushRegistration_app_identity_check" CHECK ("RunPushRegistration"."appIdentity" IN ('production', 'development'))
);
--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "RunPushRegistration" ADD CONSTRAINT "RunPushRegistration_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunPushRegistration" ADD CONSTRAINT "RunPushRegistration_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES "public"."Device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "RunPushRegistration_run_device_kind_key" ON "RunPushRegistration" USING btree ("runId","deviceId","kind");--> statement-breakpoint
CREATE INDEX "RunPushRegistration_device_idx" ON "RunPushRegistration" USING btree ("deviceId");--> statement-breakpoint
ALTER TABLE "PhotoGroupProposal" ADD CONSTRAINT "PhotoGroupProposal_origin_check" CHECK ("PhotoGroupProposal"."origin" IS NULL OR "PhotoGroupProposal"."origin" IN ('coordinator', 'external_agent', 'member'));