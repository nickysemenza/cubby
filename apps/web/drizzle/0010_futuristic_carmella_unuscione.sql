-- Drop better-auth tables that are no longer needed
ALTER TABLE "invitation" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE IF EXISTS "invitation" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "organization" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "member" CASCADE;--> statement-breakpoint
-- Add new columns
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "shortcode" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "shortcode" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "price" real;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "shortcode" text;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "yield" jsonb;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "servings" integer;--> statement-breakpoint
ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "tags" text[];--> statement-breakpoint
-- Create new indexes
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog" USING btree ("createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Ingredient_name_key" ON "Ingredient" USING btree ("name") WHERE "Ingredient"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Location_name_key" ON "Location" USING btree ("name") WHERE "Location"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Product_name_manufacturer_key" ON "Product" USING btree ("name","manufacturer") WHERE "Product"."deletedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "Recipe_name_key" ON "Recipe" USING btree ("name") WHERE "Recipe"."deletedAt" IS NULL;--> statement-breakpoint
-- Drop session column
ALTER TABLE "session" DROP COLUMN IF EXISTS "active_organization_id";--> statement-breakpoint
-- Add unique constraints for shortcodes
ALTER TABLE "Location" ADD CONSTRAINT "Location_shortcode_unique" UNIQUE("shortcode");--> statement-breakpoint
ALTER TABLE "Product" ADD CONSTRAINT "Product_shortcode_unique" UNIQUE("shortcode");--> statement-breakpoint
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_shortcode_unique" UNIQUE("shortcode");
