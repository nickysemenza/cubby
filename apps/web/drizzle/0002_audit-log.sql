CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "AuditLog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizationId" text NOT NULL,
	"entityType" text NOT NULL,
	"entityId" uuid NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb,
	"userId" text NOT NULL,
	"source" text DEFAULT 'ui' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog" USING btree ("organizationId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog" USING btree ("entityType","entityId","createdAt" DESC NULLS LAST);