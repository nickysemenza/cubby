ALTER TABLE "ProductCategory" ADD COLUMN "spendingCategoryMode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "ProductCategory" ADD COLUMN "spendingCategoryId" uuid;--> statement-breakpoint
ALTER TABLE "Vendor" ADD COLUMN "spendingProfile" text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "Vendor" ADD COLUMN "defaultSpendingCategoryId" uuid;--> statement-breakpoint
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_spendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("spendingCategoryId") REFERENCES "public"."SpendingCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_defaultSpendingCategoryId_SpendingCategory_id_fk" FOREIGN KEY ("defaultSpendingCategoryId") REFERENCES "public"."SpendingCategory"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ProductCategory_spendingCategoryId_idx" ON "ProductCategory" USING btree ("spendingCategoryId");--> statement-breakpoint
CREATE INDEX "Vendor_defaultSpendingCategoryId_idx" ON "Vendor" USING btree ("defaultSpendingCategoryId");