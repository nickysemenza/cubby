CREATE TABLE "EntitySource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"fieldPath" text,
	"url" text,
	"quote" text,
	"observedAt" timestamp,
	"selectedVariant" text,
	"valueFingerprint" text,
	"userId" text NOT NULL,
	"channel" text NOT NULL,
	"oauthClientId" text,
	"deviceId" uuid,
	"runId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "EntitySource_url_or_quote_check" CHECK ("EntitySource"."url" IS NOT NULL OR "EntitySource"."quote" IS NOT NULL),
	CONSTRAINT "EntitySource_field_fingerprint_check" CHECK (("EntitySource"."fieldPath" IS NULL) = ("EntitySource"."valueFingerprint" IS NULL)),
	CONSTRAINT "EntitySource_quote_length_check" CHECK ("EntitySource"."quote" IS NULL OR char_length("EntitySource"."quote") <= 2000),
	CONSTRAINT "EntitySource_channel_check" CHECK ("EntitySource"."channel" IN ('web', 'api', 'mcp', 'caldav', 'system'))
);
--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD COLUMN "vendorId" uuid;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "classificationStage" text;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "classificationReason" text;--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EntitySource_entity_idx" ON "EntitySource" USING btree ("entityId","createdAt");--> statement-breakpoint
ALTER TABLE "ImportPreparedOrder" ADD CONSTRAINT "ImportPreparedOrder_vendorId_Vendor_id_fk" FOREIGN KEY ("vendorId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_classification_stage_check" CHECK ("MailboxMessage"."classificationStage" IS NULL OR "MailboxMessage"."classificationStage" IN ('rule', 'jev', 'model', 'resolution'));