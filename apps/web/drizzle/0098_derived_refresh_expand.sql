CREATE TABLE "DerivedDiscoveryPass" (
	"family" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"coveredFingerprint" text,
	"runId" uuid
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshCursor" (
	"key" text PRIMARY KEY NOT NULL,
	"cursor" jsonb,
	"availableAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshFailure" (
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"phase" text NOT NULL,
	"fingerprint" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshObservedInput" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"fingerprint" text NOT NULL,
	"owners" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seenAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshPublication" (
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"phase" text NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshRevision" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshScope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workId" uuid NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"projected" boolean DEFAULT false NOT NULL,
	"traverse" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"phase" text DEFAULT 'projection' NOT NULL,
	"route" integer DEFAULT 0 NOT NULL,
	"after" uuid,
	"done" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshSnapshot" (
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DerivedRefreshWork" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"auditId" uuid,
	"inputFingerprint" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"changedFields" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"hasFailures" boolean DEFAULT false NOT NULL,
	"leaseToken" uuid,
	"leaseExpiresAt" timestamp,
	"publishing" boolean DEFAULT false NOT NULL,
	"publishAfter" uuid,
	"lastError" text,
	"availableAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_field_fingerprint_check";--> statement-breakpoint
ALTER TABLE "Run" DROP CONSTRAINT "Run_purpose_check";--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "artifactState" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "artifactHash" text;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "vectorHash" text;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "submissionId" text;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "observedAt" timestamp;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "indexedAt" timestamp;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "deletionId" text;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "availableAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "leaseToken" uuid;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "leaseExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "visibilityAttempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "EntityEmbedding" ADD COLUMN "lastError" text;--> statement-breakpoint
ALTER TABLE "DerivedDiscoveryPass" ADD CONSTRAINT "DerivedDiscoveryPass_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshFailure" ADD CONSTRAINT "DerivedRefreshFailure_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshPublication" ADD CONSTRAINT "DerivedRefreshPublication_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshScope" ADD CONSTRAINT "DerivedRefreshScope_workId_DerivedRefreshWork_id_fk" FOREIGN KEY ("workId") REFERENCES "public"."DerivedRefreshWork"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshScope" ADD CONSTRAINT "DerivedRefreshScope_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshSnapshot" ADD CONSTRAINT "DerivedRefreshSnapshot_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshWork" ADD CONSTRAINT "DerivedRefreshWork_auditId_AuditLog_id_fk" FOREIGN KEY ("auditId") REFERENCES "public"."AuditLog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DerivedRefreshWork" ADD CONSTRAINT "DerivedRefreshWork_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "DerivedRefreshFailure_input_key" ON "DerivedRefreshFailure" USING btree ("entityKind","entityId","phase","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "DerivedRefreshPublication_entity_phase_key" ON "DerivedRefreshPublication" USING btree ("entityKind","entityId","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "DerivedRefreshScope_wave_entity_key" ON "DerivedRefreshScope" USING btree ("workId","entityKind","entityId");--> statement-breakpoint
CREATE INDEX "DerivedRefreshScope_pending_idx" ON "DerivedRefreshScope" USING btree ("workId","done","id");--> statement-breakpoint
CREATE UNIQUE INDEX "DerivedRefreshSnapshot_entity_key" ON "DerivedRefreshSnapshot" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "DerivedRefreshWork_root_key" ON "DerivedRefreshWork" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE INDEX "DerivedRefreshWork_due_idx" ON "DerivedRefreshWork" USING btree ("state","availableAt","id");--> statement-breakpoint
CREATE INDEX "DerivedRefreshWork_entity_idx" ON "DerivedRefreshWork" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "EntityEmbedding_one_submission_key" ON "EntityEmbedding" USING btree ("entityKind","entityId","provider","model","dimensions") WHERE "EntityEmbedding"."artifactState" IN ('prepared','submitting','submitted');--> statement-breakpoint
CREATE INDEX "EntityEmbedding_recovery_idx" ON "EntityEmbedding" USING btree ("availableAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_derived_refresh" ON "Run" USING btree ("purpose") WHERE "Run"."purpose" = 'derived_refresh' AND "Run"."status" IN ('running', 'paused_auth', 'paused');--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_field_fingerprint_check" CHECK ("EntitySource"."fieldPath" IS NOT NULL OR "EntitySource"."valueFingerprint" IS NULL);--> statement-breakpoint
ALTER TABLE "Run" ADD CONSTRAINT "Run_purpose_check" CHECK ("Run"."purpose" IN ('account_sync', 'mail_import', 'purchase_validation', 'product_enrichment', 'photo_inventory', 'ai_suggest', 'suggestion_sweep', 'ai_refresh', 'background', 'file_import', 'mail_search', 'mail_discovery', 'mail_reclassify', 'maintenance', 'derived_refresh', 'sweep'));
--> statement-breakpoint
CREATE TABLE "DerivedRefreshCaptureInbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"change" jsonb NOT NULL,
	"inputFingerprint" text NOT NULL,
	"force" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "DerivedRefreshCaptureInbox" ADD CONSTRAINT "DerivedRefreshCaptureInbox_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "DerivedRefreshCaptureInbox_order_idx" ON "DerivedRefreshCaptureInbox" USING btree ("createdAt","id");--> statement-breakpoint
CREATE INDEX "DerivedRefreshCaptureInbox_kind_idx" ON "DerivedRefreshCaptureInbox" USING btree ("entityKind");
