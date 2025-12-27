ALTER TABLE "Product" ADD COLUMN "category" text;--> statement-breakpoint
CREATE INDEX "Product_category_idx" ON "Product" USING btree ("category");