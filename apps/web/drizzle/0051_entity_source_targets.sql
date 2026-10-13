ALTER TABLE "EntitySource" DROP CONSTRAINT "EntitySource_url_or_quote_check";--> statement-breakpoint
ALTER TABLE "EntitySource" ADD COLUMN "sourceEntityId" uuid;--> statement-breakpoint
ALTER TABLE "EntitySource" ADD COLUMN "sourceEntityKind" text;--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_target_fk" FOREIGN KEY ("sourceEntityId","sourceEntityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "EntitySource_target_idx" ON "EntitySource" USING btree ("sourceEntityId");--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_target_pair_check" CHECK (("EntitySource"."sourceEntityId" IS NULL) = ("EntitySource"."sourceEntityKind" IS NULL));--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_one_target_check" CHECK ("EntitySource"."url" IS NULL OR "EntitySource"."sourceEntityId" IS NULL);--> statement-breakpoint
ALTER TABLE "EntitySource" ADD CONSTRAINT "EntitySource_target_or_quote_check" CHECK ("EntitySource"."url" IS NOT NULL OR "EntitySource"."sourceEntityId" IS NOT NULL OR "EntitySource"."quote" IS NOT NULL);