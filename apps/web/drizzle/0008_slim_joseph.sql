ALTER TABLE "Cookbook" ADD COLUMN "coverImageId" uuid;--> statement-breakpoint
ALTER TABLE "Cookbook" ADD CONSTRAINT "Cookbook_coverImageId_Image_id_fk" FOREIGN KEY ("coverImageId") REFERENCES "public"."Image"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "Cookbook_coverImageId_idx" ON "Cookbook" USING btree ("coverImageId");