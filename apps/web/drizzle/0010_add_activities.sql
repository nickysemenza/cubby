-- Activity Type table - defines activities that can be performed on products
CREATE TABLE "ActivityType" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"productId" uuid NOT NULL,
	"name" text NOT NULL,
	"intervalDays" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Activity Entry table - logs when activities were completed
CREATE TABLE "ActivityEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activityTypeId" uuid NOT NULL,
	"completedAt" timestamp NOT NULL,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Activity Entry Image join table
CREATE TABLE "ActivityEntryImage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activityEntryId" uuid NOT NULL,
	"imageId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Add foreign keys
ALTER TABLE "ActivityType" ADD CONSTRAINT "ActivityType_productId_Product_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ActivityEntry" ADD CONSTRAINT "ActivityEntry_activityTypeId_ActivityType_id_fk" FOREIGN KEY ("activityTypeId") REFERENCES "public"."ActivityType"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ActivityEntryImage" ADD CONSTRAINT "ActivityEntryImage_activityEntryId_ActivityEntry_id_fk" FOREIGN KEY ("activityEntryId") REFERENCES "public"."ActivityEntry"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ActivityEntryImage" ADD CONSTRAINT "ActivityEntryImage_imageId_Image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."Image"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Add indexes
CREATE UNIQUE INDEX "ActivityType_productId_name_key" ON "ActivityType" USING btree ("productId","name");
--> statement-breakpoint
CREATE INDEX "ActivityType_productId_idx" ON "ActivityType" USING btree ("productId");
--> statement-breakpoint
CREATE INDEX "ActivityEntry_activityTypeId_idx" ON "ActivityEntry" USING btree ("activityTypeId");
--> statement-breakpoint
CREATE INDEX "ActivityEntry_completedAt_idx" ON "ActivityEntry" USING btree ("completedAt" DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX "ActivityEntryImage_activityEntryId_imageId_key" ON "ActivityEntryImage" USING btree ("activityEntryId","imageId");
--> statement-breakpoint
CREATE INDEX "ActivityEntryImage_activityEntryId_idx" ON "ActivityEntryImage" USING btree ("activityEntryId");
--> statement-breakpoint
CREATE INDEX "ActivityEntryImage_imageId_idx" ON "ActivityEntryImage" USING btree ("imageId");
